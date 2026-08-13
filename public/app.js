import { buildArgs, num, clamp, even, atempoChain, OPERATIONS } from './operations.js';
import { parseCommand, describeSteps } from './parser.js';

/** Pretty names for multi-step confirmations, derived from the registry. */
const OPERATION_LABELS = Object.fromEntries(
  Object.entries(OPERATIONS).map(([k, v]) => [k, (v.label || k).toLowerCase()])
);

// State
let currentVideoBlob = null;
let currentVideoUrl = null;
let isProcessing = false;
let ffmpeg = null;

// Elements
const landingScreen = document.getElementById('landing-screen');
const editorScreen = document.getElementById('editor-screen');
const uploadZone = document.getElementById('upload-zone');
const videoUpload = document.getElementById('video-upload');
const videoPlayer = document.getElementById('video-player');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const modalClose = document.getElementById('modal-close');
const processingIndicator = document.getElementById('processing-indicator');
const processingText = document.getElementById('processing-text');
const progressFill = document.getElementById('progress-fill');
const projectName = document.getElementById('project-name');
const timeDisplay = document.getElementById('time-display');
const playBtn = document.getElementById('play-btn');
const stopBtn = document.getElementById('stop-btn');
const playhead = document.getElementById('playhead');
const timeline = document.getElementById('timeline');
const apiKeyBanner = document.getElementById('api-key-banner');
const landingApiKey = document.getElementById('landing-api-key');
const landingSaveKey = document.getElementById('landing-save-key');

// Initialize FFmpeg
let ffmpegInitPromise = null;
let ffmpegIsMT = false;
let videoMetaCache = null;      // { duration, width, height, hasAudio } per clip
let lastWrittenFiles = [];      // virtual-FS cleanup between runs
let opsSinceLoad = 0;           // recycle the wasm heap periodically
const history = [];             // previous blobs, for undo

/** Shared progress handler (re-attached when the instance is recreated). */
function onProgress({ progress }) {
  const pct = Math.max(0, Math.min(100, Math.round((progress || 0) * 100)));
  if (progressFill) progressFill.style.width = pct + '%';
  if (processingText && pct > 0) processingText.textContent = `Processing... ${pct}%`;
}

/**
 * The multithreaded core needs SharedArrayBuffer, which browsers only expose in
 * a cross-origin-isolated context (COOP: same-origin + COEP: require-corp).
 * Those headers are set in vercel.json.
 */
function isMultithreadSupported() {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof self.crossOriginIsolated !== 'undefined' &&
    self.crossOriginIsolated === true
  );
}

/** Leave a core free so the UI stays responsive; cap at 8 (diminishing returns). */
function threadCount() {
  const n = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(8, n - 1));
}

/** Reject if a promise hasn't settled in `ms` — nothing may hang forever. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

/** Throw the whole instance away — used after an abort so the next run is clean. */
function resetFFmpeg() {
  try { ffmpeg && ffmpeg.terminate && ffmpeg.terminate(); } catch {}
  ffmpeg = null;
  ffmpegInitPromise = null;
  ffmpegIsMT = false;
  opsSinceLoad = 0;
  lastWrittenFiles = [];
}

async function initFFmpeg() {
  if (ffmpeg && ffmpeg.loaded) return ffmpeg;
  
  // If already initializing, wait for that promise
  if (ffmpegInitPromise) return ffmpegInitPromise;
  
  ffmpegInitPromise = (async () => {
    try {
      const { FFmpeg } = FFmpegWASM;
      ffmpeg = new FFmpeg();

      // Surface FFmpeg's own logs so failures are diagnosable in the console
      ffmpeg.on('log', ({ message }) => console.log('[ffmpeg]', message));

      // Drive the real progress bar instead of leaving it stuck at 0%
      ffmpeg.on('progress', onProgress);

      // Do NOT pass `classWorkerURL`. Two traps in @ffmpeg/ffmpeg 0.12.x:
      //
      //  1. It is resolved against a path baked in at the library's BUILD time —
      //     "file:///home/jeromewu/ffmpeg.wasm/.../classes.js" — so a root-relative
      //     value becomes file:///ffmpeg/814.ffmpeg.js and the browser refuses it.
      //  2. It also forces {type:"module"}, but that worker calls importScripts(),
      //     which does not exist in module workers.
      //
      // Omitting it lets webpack's automatic publicPath derive the URL from where
      // ffmpeg.js was served, giving <origin>/ffmpeg/814.ffmpeg.js as a CLASSIC
      // worker — already correct, since we ship it alongside ffmpeg.js.
      //
      // `workerURL` is a DIFFERENT option, consumed inside the worker by the core
      // itself for its pthread pool. The multithreaded core requires it.
      // The multithreaded core (@ffmpeg/core-mt) was tried here and REVERTED.
      // Under real use it throws "function signature mismatch" mid-encode and
      // takes the whole tab down with it — verified in an automated browser run
      // where MT crashed on 4 of 5 commands while the single-threaded core
      // passed all 5. Threads are not worth a crash; the speed now comes from
      // stream-copy fast paths instead (see operations.js).
      await withTimeout(ffmpeg.load({
        coreURL: '/ffmpeg/st/ffmpeg-core.js',
        wasmURL: '/ffmpeg/st/ffmpeg-core.wasm',
      }), 60000, 'FFmpeg load');

      ffmpegIsMT = false;
      console.log(`[ffmpeg] loaded single-threaded core (${navigator.hardwareConcurrency || '?'} cores reported)`);

      return ffmpeg;
    } catch (err) {
      ffmpegInitPromise = null; // Reset on failure so we can retry
      throw err;
    }
  })();
  
  return ffmpegInitPromise;
}

// Editing no longer requires an API key: the local parser understands most
// commands offline. The key is optional and only widens the phrasing the app
// can interpret, so never gate the upload behind it.
window.addEventListener('DOMContentLoaded', () => {
  if (apiKeyBanner) apiKeyBanner.style.display = 'none';
  if (uploadZone) uploadZone.style.display = 'block';
});

// API key handling
landingSaveKey.addEventListener('click', () => {
  const key = landingApiKey.value.trim();
  if (key) {
    localStorage.setItem('api_key', key);
    apiKeyBanner.style.display = 'none';
    uploadZone.style.display = 'block';
  }
});

// Upload handling
uploadZone.addEventListener('click', () => videoUpload.click());

uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('dragover');
});

uploadZone.addEventListener('dragleave', () => {
  uploadZone.classList.remove('dragover');
});

uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('video/')) {
    handleVideoFile(file);
  }
});

videoUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleVideoFile(file);
});

async function handleVideoFile(file) {
  currentVideoBlob = file;
  currentVideoUrl = URL.createObjectURL(file);
  videoPlayer.src = currentVideoUrl;
  projectName.textContent = file.name.replace(/\.[^/.]+$/, '');

  switchToEditor();

  // Start fetching the ~32MB core NOW, while the user is typing their first
  // command, instead of waiting until they hit send. Usually hides the entire
  // load time. Errors are ignored here — processVideo() awaits it properly.
  initFFmpeg().catch(() => {});

  // Cache the audio-track check so we don't redo it on every single edit
  videoMetaCache = null;
}

function switchToEditor() {
  landingScreen.classList.remove('active');
  editorScreen.classList.add('active');
}

// Video controls
playBtn.addEventListener('click', () => {
  if (videoPlayer.paused) {
    videoPlayer.play();
  } else {
    videoPlayer.pause();
  }
});

stopBtn.addEventListener('click', () => {
  videoPlayer.pause();
  videoPlayer.currentTime = 0;
});

videoPlayer.addEventListener('timeupdate', () => {
  const current = formatTime(videoPlayer.currentTime);
  const total = formatTime(videoPlayer.duration || 0);
  timeDisplay.textContent = `${current} / ${total}`;

  if (videoPlayer.duration) {
    const percent = (videoPlayer.currentTime / videoPlayer.duration) * 100;
    playhead.style.left = `${percent}%`;
  }
});

timeline.addEventListener('click', (e) => {
  if (videoPlayer.duration) {
    const rect = timeline.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    videoPlayer.currentTime = percent * videoPlayer.duration;
  }
});

// Chat handling
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 80) + 'px';
});

sendBtn.addEventListener('click', sendMessage);

// Suggestion chips
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    chatInput.value = chip.dataset.command;
    sendMessage();
  });
});

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || isProcessing || !currentVideoBlob) return;

  addMessage('user', text);
  chatInput.value = '';
  chatInput.style.height = 'auto';
  sendBtn.disabled = true;
  isProcessing = true;

  try {
    const meta = await probeVideo(currentVideoBlob).catch(() => ({}));

    // 1) Try to understand the command locally. This handles the vast majority
    //    of real requests with no API key, no network round-trip, and no
    //    chance of a hallucinated operation — and it supports multi-step
    //    commands, which the AI path could never express.
    let steps = null;
    let source = 'local';
    const local = parseCommand(text, meta);

    if (local.matched && local.unmatched.length === 0) {
      steps = local.steps;
    } else {
      // 2) Fall back to the AI for phrasing the parser does not know.
      const apiKey = localStorage.getItem('api_key');
      if (!apiKey) {
        if (local.matched) {
          steps = local.steps;               // partial understanding beats nothing
        } else {
          addMessage('ai', didYouMean(text));
          return;
        }
      } else {
        showProcessing('Thinking...');
        try {
          const aiResponse = await fetch('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              command: text,
              apiKey,
              model: localStorage.getItem('model') || 'llama-3.3-70b-versatile',
              meta,
            }),
          });
          const aiData = await aiResponse.json().catch(() => ({}));
          if (aiResponse.ok && aiData.success && aiData.result?.operation) {
            steps = [aiData.result];
            source = 'ai';
            if (aiData.result.response) addMessage('ai', aiData.result.response);
          }
        } catch {
          /* network/AI failure falls through to the local result below */
        }
        if (!steps && local.matched) steps = local.steps;
        if (!steps) { addMessage('ai', didYouMean(text)); return; }
      }
    }

    // 3) Run the plan. Multi-step commands chain: each step edits the result
    //    of the previous one, and a failure stops the chain rather than
    //    silently leaving the clip half-edited.
    const multi = steps.length > 1;
    if (multi) {
      addMessage('ai', `On it — ${describeSteps(steps, OPERATION_LABELS)}.`);
    }

    const t0 = performance.now();
    for (let i = 0; i < steps.length; i++) {
      const label = multi ? ` (${i + 1}/${steps.length})` : '';
      showProcessing(`Processing${label}...`);
      // Only the final step announces itself, so a chain reads as one action.
      await processVideo(steps[i], { quiet: multi });
    }

    if (multi) {
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      addMessage('ai', `All ${steps.length} steps done in ${secs}s.`);
    }

  } catch (err) {
    console.error('Send message error:', err);
    addMessage('ai', 'Error: ' + (err?.message || String(err) || 'Unknown error'));
  } finally {
    hideProcessing();
    sendBtn.disabled = false;
    isProcessing = false;
  }
}

/** Friendly, specific fallback when nothing matched. */
function didYouMean(text) {
  const t = String(text).toLowerCase();
  const hints = [
    [/\b(?:music|song|soundtrack|audio track|add sound)\b/, "I can't add new audio yet — but I can mute, clean, normalise or fade the existing track."],
    [/\b(?:merge|join|combine|stitch|append|two videos|another video)\b/, 'I can only edit one clip at a time right now — joining clips isn\u2019t supported yet.'],
    [/\b(?:green ?screen|chroma|remove background|cut out)\b/, "Background removal isn't supported yet. Try 'blur the background' for a similar look."],
    [/\b(?:subtitle|transcri|caption file|srt)\b/, "I can't auto-transcribe yet, but you can add text: try: add text saying Your Words."],
    [/\b(?:upscale|enhance quality|4k|sharper quality)\b/, "I can resize up, but I can't invent detail. Try 'resize to 1080p' or 'sharpen'."],
  ];
  for (const [re, msg] of hints) if (re.test(t)) return msg;
  return "I didn't catch that. Try things like: 'trim the first 5 seconds', " +
         "'make it black and white', 'crop for TikTok', 'speed it up 2x', " +
         "'add text saying Hello', or 'compress it'. You can chain them with 'and'.";
}

/**
 * Probe the clip once: duration, dimensions, audio presence.
 * Cached per uploaded file so we never re-probe on every edit.
 */
function probeVideo(blob) {
  if (videoMetaCache) return Promise.resolve(videoMetaCache);
  return new Promise((resolve) => {
    const fallback = { duration: 0, width: 0, height: 0, hasAudio: true };
    let settled = false;
    const finish = (meta) => {
      if (settled) return;
      settled = true;
      videoMetaCache = meta;
      resolve(meta);
    };
    try {
      const el = document.createElement('video');
      el.preload = 'metadata';
      el.muted = true;
      const url = URL.createObjectURL(blob);
      const timer = setTimeout(() => { URL.revokeObjectURL(url); finish(fallback); }, 5000);
      el.onloadedmetadata = async () => {
        clearTimeout(timer);
        const meta = {
          duration: Number.isFinite(el.duration) ? el.duration : 0,
          width: el.videoWidth || 0,
          height: el.videoHeight || 0,
          hasAudio: Boolean(
            el.mozHasAudio ||
            el.webkitAudioDecodedByteCount > 0 ||
            (el.audioTracks && el.audioTracks.length > 0)
          ),
        };
        // Chrome defines webkitAudioDecodedByteCount but leaves it at 0 until
        // frames are actually decoded, so metadata alone makes EVERY clip look
        // silent (measured: 0 for both a silent and an audio clip). A brief
        // muted play decodes a few frames and separates them (0 vs 7058).
        if (!meta.hasAudio && typeof el.webkitAudioDecodedByteCount === 'number') {
          try {
            el.muted = true;
            await el.play();
            await new Promise((r) => setTimeout(r, 250));
            el.pause();
            meta.hasAudio = el.webkitAudioDecodedByteCount > 0;
          } catch {
            // Autoplay refused: assume audio so we never wrongly refuse a
            // volume/extract request. FFmpeg reports it properly either way.
            meta.hasAudio = true;
          }
        }
        URL.revokeObjectURL(url);
        finish(meta);
      };
      el.onerror = () => { clearTimeout(timer); URL.revokeObjectURL(url); finish(fallback); };
      el.src = url;
    } catch {
      finish(fallback);
    }
  });
}

async function processVideo(operation, opts = {}) {
  const meta = await probeVideo(currentVideoBlob);

  const ctx = {
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    hasAudio: meta.hasAudio,
    threads: threadCount(),
    isMT: ffmpegIsMT,
    inputName: 'input.mp4',
  };

  // Validate and build BEFORE touching FFmpeg, so bad AI output costs nothing
  const plan = buildArgs(operation.operation, operation.parameters, ctx);
  if (plan.error) {
    addMessage('ai', plan.error);
    return;
  }

  // Set expectations. WASM is far slower than native ffmpeg.
  const heavy = !plan.args.includes('copy');
  if (meta.duration > 90 && heavy) {
    addMessage('ai', `This clip is ${Math.round(meta.duration / 60)} min, so re-encoding in the browser will take a while. Trimming first is much faster.`);
  }

  const ffmpegInstance = await withTimeout(initFFmpeg(), 90000, 'FFmpeg startup');
  if (!ffmpegInstance || !ffmpegInstance.loaded) {
    throw new Error('FFmpeg failed to start. Reload the page and try again.');
  }

  const t0 = performance.now();
  let aborted = false;

  try {
    // Clean any leftovers from a previous run
    for (const f of lastWrittenFiles) {
      try { await ffmpegInstance.deleteFile(f); } catch {}
    }
    lastWrittenFiles = [];

    // writeFile TRANSFERS the buffer to the worker, which DETACHES it here.
    // Reusing a detached buffer on the next command throws
    // "An ArrayBuffer is detached and could not be cloned" — that was the real
    // cause of the second command hanging forever. Re-read the blob each run so
    // the worker always gets a fresh, owned buffer.
    const fileData = new Uint8Array(await currentVideoBlob.arrayBuffer());
    await ffmpegInstance.writeFile('input.mp4', fileData);
    lastWrittenFiles.push('input.mp4');

    // The wasm core has no fontconfig, so drawtext must be handed an explicit
    // fontfile or it writes a zero-byte output. Load one on demand.
    if (plan.needsFont) {
      const fontRes = await fetch('/font.ttf');
      if (!fontRes.ok) throw new Error('Could not load the text font.');
      await ffmpegInstance.writeFile('font.ttf', new Uint8Array(await fontRes.arrayBuffer()));
      lastWrittenFiles.push('font.ttf');
    }

    console.log('FFmpeg command:', plan.args.join(' '));

    // Scale the timeout to the clip: never infinite, never unfairly short.
    const budgetMs = Math.min(
      15 * 60 * 1000,
      Math.max(60000, (meta.duration || 10) * (heavy ? 12000 : 1500))
    );
    await withTimeout(ffmpegInstance.exec(plan.args), budgetMs, 'Processing');

    const data = await ffmpegInstance.readFile(plan.outputName);
    lastWrittenFiles.push(plan.outputName);

    if (!data || data.byteLength === 0) {
      throw new Error('FFmpeg produced an empty file — the command may not suit this clip.');
    }

    const blob = new Blob([data.buffer], { type: plan.mime });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const mb = (blob.size / 1048576).toFixed(1);

    if (plan.kind === 'video') {
      if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
      pushHistory(currentVideoBlob);
      currentVideoBlob = blob;
      currentVideoUrl = URL.createObjectURL(blob);
      videoPlayer.src = currentVideoUrl;
      videoMetaCache = null;               // dimensions/duration may have changed
      // On a multi-step chain only the final step reports, so the transcript
      // reads as one action instead of a wall of timings.
      if (!opts.quiet) {
        addMessage('ai', `Done in ${secs}s · ${mb} MB`);
      }
      updateUndoButton();
    } else {
      // Image or audio side-output: offer it as a download, keep the video as-is
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${projectName.textContent || 'cutflow'}.${plan.ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      addMessage('ai', `${plan.label} ready — downloaded (${mb} MB, ${secs}s).`);
    }
  } catch (err) {
    aborted = true;
    const msg = String(err && err.message || err);
    console.error('FFmpeg error:', err);
    if (/timed out/i.test(msg)) {
      throw new Error(`${msg}. Try a shorter clip, or trim it first.`);
    }
    if (/abort|memory|OOM|RuntimeError/i.test(msg)) {
      throw new Error('Ran out of memory on this clip. Try a shorter or smaller video.');
    }
    throw new Error(msg.replace(/^Error:\s*/, ''));
  } finally {
    // The WASM core frequently reports Aborted() after a run. Reusing a crashed
    // instance is what made the SECOND command hang forever, so bin it and let
    // the next command start a fresh one.
    if (aborted) {
      resetFFmpeg();
    } else {
      // Delete EVERYTHING written this run, not just input/output. The wasm
      // heap never shrinks, so leaked files (font.ttf, palettes, side outputs)
      // accumulate across commands until the tab is OOM-killed — that is what
      // crashed the page after ~20 sequential operations.
      for (const f of new Set([...lastWrittenFiles, plan.outputName])) {
        try { await ffmpegInstance.deleteFile(f); } catch {}
      }
      lastWrittenFiles = [];
      opsSinceLoad++;
      // Even with clean deletes the heap creeps upward. Recycle the instance
      // periodically; a reload costs ~1s versus losing the user's session.
      if (opsSinceLoad >= 12) {
        console.log('[ffmpeg] recycling instance after', opsSinceLoad, 'operations');
        resetFFmpeg();
      }
    }
  }
}

function addMessage(sender, text) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message' + (sender === 'ai' ? ' ai-message' : '');

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = sender === 'ai' ? 'AI' : 'You';

  const content = document.createElement('div');
  content.className = 'message-content';

  const p = document.createElement('p');
  p.textContent = text;
  content.appendChild(p);

  msgDiv.appendChild(avatar);
  msgDiv.appendChild(content);

  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function pushHistory(blob) {
  history.push(blob);
  if (history.length > 10) history.shift();   // cap memory
}

function updateUndoButton() {
  const btn = document.getElementById('undo-btn');
  if (btn) btn.disabled = history.length === 0;
}

// Settings modal
settingsBtn.addEventListener('click', () => {
  settingsModal.style.display = 'flex';
  document.getElementById('settings-api-key').value = localStorage.getItem('api_key') || '';
  document.getElementById('settings-model').value = localStorage.getItem('model') || 'llama-3.3-70b-versatile';
});

modalClose.addEventListener('click', () => {
  settingsModal.style.display = 'none';
});

document.querySelector('.modal-overlay').addEventListener('click', () => {
  settingsModal.style.display = 'none';
});

document.getElementById('save-settings').addEventListener('click', () => {
  const key = document.getElementById('settings-api-key').value.trim();
  const model = document.getElementById('settings-model').value;
  
  if (key) {
    localStorage.setItem('api_key', key);
    localStorage.setItem('model', model);
    settingsModal.style.display = 'none';
    addMessage('ai', '✓ Settings saved');
  }
});

// Undo — restore the previous version of the clip
const undoBtn = document.getElementById('undo-btn');
if (undoBtn) {
  undoBtn.addEventListener('click', () => {
    if (!history.length || isProcessing) return;
    const prev = history.pop();
    if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
    currentVideoBlob = prev;
    currentVideoUrl = URL.createObjectURL(prev);
    videoPlayer.src = currentVideoUrl;
    videoMetaCache = null;
    addMessage('ai', 'Reverted to the previous version.');
    updateUndoButton();
  });
}

// Cancel — kill a running job instead of forcing a page reload
const cancelBtn = document.getElementById('cancel-btn');
if (cancelBtn) {
  cancelBtn.addEventListener('click', () => {
    if (!isProcessing) return;
    addMessage('ai', 'Cancelled.');
    resetFFmpeg();          // terminates the worker mid-exec
    hideProcessing();
    isProcessing = false;
    sendBtn.disabled = false;
  });
}

// Export
document.getElementById('export-btn').addEventListener('click', () => {
  if (!currentVideoBlob) {
    addMessage('ai', 'Upload a video first.');
    return;
  }

  // Leaking the object URL kept the whole blob in memory; revoke it after use
  const url = URL.createObjectURL(currentVideoBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${projectName.textContent || 'video'}_edited.mp4`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});

// Helpers

// Coerce whatever the LLM returned into a usable number
function formatTime(seconds) {
  if (isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function showProcessing(text) {
  processingIndicator.style.display = 'flex';
  processingText.textContent = text;
  progressFill.style.width = '0%';
}

function hideProcessing() {
  processingIndicator.style.display = 'none';
  progressFill.style.width = '0%';
}

// Migration: Clear old Gemini settings
if (localStorage.getItem('gemini_model')) {
  localStorage.removeItem('gemini_model');
  localStorage.removeItem('api_key');
}
