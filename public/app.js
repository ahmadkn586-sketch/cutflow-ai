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
      ffmpeg.on('progress', ({ progress }) => {
        const pct = Math.max(0, Math.min(100, Math.round((progress || 0) * 100)));
        if (progressFill) progressFill.style.width = pct + '%';
        if (processingText && pct > 0) processingText.textContent = `Processing video... ${pct}%`;
      });

      // Do NOT pass any worker URL option here. Two separate traps in
      // @ffmpeg/ffmpeg 0.12.x:
      //
      //  1. `classWorkerURL` is resolved against a path baked in at the library's
      //     BUILD time — "file:///home/jeromewu/ffmpeg.wasm/.../classes.js". A
      //     root-relative value like "/ffmpeg/814.ffmpeg.js" therefore becomes
      //     file:///ffmpeg/814.ffmpeg.js, which the browser refuses with
      //     "Failed to construct 'Worker' ... cannot be accessed from origin".
      //
      //  2. `classWorkerURL` also forces {type:"module"}, but this worker calls
      //     importScripts(), which does not exist inside a module worker. So even
      //     a fully-qualified https URL fails on the following line.
      //
      // With the option omitted, webpack's automatic publicPath derives the worker
      // URL from wherever ffmpeg.js itself was served (document.currentScript.src),
      // producing <origin>/ffmpeg/814.ffmpeg.js as a CLASSIC worker. Since we ship
      // 814.ffmpeg.js right next to ffmpeg.js in public/ffmpeg/, that is already
      // correct and same-origin. coreURL/wasmURL are still passed explicitly so the
      // 32MB core loads locally instead of from unpkg.
      await ffmpeg.load({
        coreURL: '/ffmpeg/ffmpeg-core.js',
        wasmURL: '/ffmpeg/ffmpeg-core.wasm',
      });

      return ffmpeg;
    } catch (err) {
      ffmpegInitPromise = null; // Reset on failure so we can retry
      throw err;
    }
  })();
  
  return ffmpegInitPromise;
}

// Check for API key on load
window.addEventListener('DOMContentLoaded', () => {
  const apiKey = localStorage.getItem('api_key');
  if (apiKey) {
    apiKeyBanner.style.display = 'none';
    uploadZone.style.display = 'block';
  }
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

  const apiKey = localStorage.getItem('api_key');
  if (!apiKey) {
    addMessage('ai', 'Please set your API key first');
    return;
  }

  addMessage('user', text);
  chatInput.value = '';
  chatInput.style.height = 'auto';
  sendBtn.disabled = true;
  isProcessing = true;

  try {
    // Get AI command
    showProcessing('AI is thinking...');
    const aiResponse = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: text,
        apiKey,
        model: localStorage.getItem('model') || 'llama-3.3-70b-versatile'
      })
    });

    let aiData = {};
    try {
      aiData = await aiResponse.json();
    } catch {
      throw new Error(`Server returned an invalid response (HTTP ${aiResponse.status})`);
    }

    if (!aiResponse.ok || !aiData.success) {
      throw new Error(aiData.error || `AI request failed (HTTP ${aiResponse.status})`);
    }

    addMessage('ai', aiData.result.response || `Applying: ${aiData.result.description}`);

    // Process video with FFmpeg
    showProcessing('Processing video...');
    await processVideo(aiData.result);

  } catch (err) {
    console.error('Send message error:', err);
    console.error('Error stack:', err?.stack);
    addMessage('ai', 'Error: ' + (err?.message || err?.toString() || String(err) || 'Unknown error'));
  } finally {
    hideProcessing();
    sendBtn.disabled = false;
    isProcessing = false;
  }
}

async function processVideo(operation) {
  console.log('Processing operation:', operation);
  
  // Ensure FFmpeg is initialized and loaded
  const ffmpegInstance = await initFFmpeg();
  
  // Double-check it's actually loaded
  if (!ffmpegInstance || !ffmpegInstance.loaded) {
    throw new Error('FFmpeg is not ready. Please try again.');
  }
  
  try {
    // Write input file
    const inputName = 'input.mp4';
    const outputName = 'output.mp4';
    
    const fileData = await currentVideoBlob.arrayBuffer();
    await ffmpegInstance.writeFile(inputName, new Uint8Array(fileData));

    // Does this file even have an audio track? Applying -filter:a to a silent
    // video makes FFmpeg abort with "Stream specifier ':a' matches no streams".
    const hasAudio = await videoHasAudio(currentVideoBlob);

    // Build FFmpeg command based on operation.
    // Every arg MUST be a string — ffmpeg.wasm passes argv straight through and
    // a raw JS number throws "args must be an array of strings".
    const args = ['-i', inputName];
    const p = operation.parameters || {};

    switch (operation.operation) {
      case 'trim_video':
        args.push('-ss', String(num(p.start, 0)));
        args.push('-t', String(num(p.duration, 10)));
        break;

      case 'resize_video':
        // Force even dimensions — H.264 (yuv420p) rejects odd width/height
        args.push('-vf', `scale=${even(num(p.width, 1280))}:${even(num(p.height, 720))}`);
        break;

      case 'crop_video': {
        const width  = even(num(p.width, 1280));
        const height = even(num(p.height, 720));
        const x = num(p.x, 0), y = num(p.y, 0);
        args.push('-vf', `crop=${width}:${height}:${x}:${y}`);
        break;
      }

      case 'adjust_speed': {
        const speed = clamp(num(p.speed, 1), 0.25, 8);
        args.push('-filter:v', `setpts=${(1 / speed).toFixed(6)}*PTS`);
        if (hasAudio) args.push('-filter:a', atempoChain(speed));
        else args.push('-an');
        break;
      }

      case 'slow_motion': {
        // factor 2 = half speed
        const factor = clamp(num(p.factor, 2), 1, 8);
        const speed = 1 / factor;
        args.push('-filter:v', `setpts=${factor.toFixed(6)}*PTS`);
        // atempo needs a literal float, not the expression "1/2"
        if (hasAudio) args.push('-filter:a', atempoChain(speed));
        else args.push('-an');
        break;
      }

      case 'speed_up': {
        const factor = clamp(num(p.factor, 2), 1, 8);
        args.push('-filter:v', `setpts=${(1 / factor).toFixed(6)}*PTS`);
        if (hasAudio) args.push('-filter:a', atempoChain(factor));
        else args.push('-an');
        break;
      }

      case 'mute_audio':
        args.push('-an');
        break;

      case 'adjust_volume':
        if (hasAudio) args.push('-af', `volume=${num(p.level, 1)}`);
        break;
        
      case 'color_grade': {
        const grade = String(p.grade || 'warm').toLowerCase();
        const gradeFilters = {
          warm: 'colorbalance=rs=0.3:gs=0:bs=-0.3',
          cool: 'colorbalance=rs=-0.3:gs=0:bs=0.3',
          vintage: 'curves=preset=vintage',
          // "cinematic" = teal/orange push + slight contrast, not just "lighter"
          cinematic: 'colorbalance=rs=0.15:bs=-0.15:rm=0.05:bm=-0.05,eq=contrast=1.15:saturation=1.1'
        };
        args.push('-vf', gradeFilters[grade] || gradeFilters.warm);
        break;
      }

      case 'add_effect':
      case 'add_filter': {
        const effect = String(p.effect || p.filter || 'blur').toLowerCase();
        const effectFilters = {
          blur: 'boxblur=5:1',
          sharpen: 'unsharp=5:5:1.5',
          grayscale: 'hue=s=0',
          sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
          // "curves=vintage" is invalid syntax; the preset= form is required
          vintage: 'curves=preset=vintage',
          emboss: 'convolution=-2 -1 0:-1 1 1:0 1 2',
          edge: 'edgedetect=low=0.1:high=0.4',
          brightness: `eq=brightness=${clamp(num(p.intensity, 50) / 100 - 0.5, -1, 1).toFixed(3)}`,
          contrast: `eq=contrast=${clamp(num(p.intensity, 50) / 50, 0, 3).toFixed(3)}`,
          saturation: `eq=saturation=${clamp(num(p.intensity, 50) / 50, 0, 3).toFixed(3)}`
        };
        args.push('-vf', effectFilters[effect] || effectFilters.blur);
        break;
      }

      default:
        throw new Error(`Unknown operation: ${operation.operation}`);
    }

    // Re-encode to a browser-playable MP4. Without yuv420p + faststart the
    // output often plays audio-only or not at all in Chrome/Safari.
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
    args.push('-movflags', '+faststart');
    args.push(outputName);

    console.log('FFmpeg command:', args);
    // Run FFmpeg
    await ffmpegInstance.exec(args);

    // Read output
    const data = await ffmpegInstance.readFile(outputName);
    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    
    // Update video
    if (currentVideoUrl) {
      URL.revokeObjectURL(currentVideoUrl);
    }
    currentVideoBlob = blob;
    currentVideoUrl = URL.createObjectURL(blob);
    videoPlayer.src = currentVideoUrl;
    
    addMessage('ai', '✓ Video processed successfully');

  } catch (err) {
    console.error('FFmpeg error:', err);
    console.error('Error type:', typeof err);
    console.error('Error keys:', Object.keys(err || {}));
    const errorMsg = err?.message || err?.toString() || String(err) || 'Unknown error';
    throw new Error('Video processing failed: ' + errorMsg);
  }
}

function addMessage(sender, text) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message';
  
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
function num(v, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// H.264 requires even dimensions
function even(n) {
  const v = Math.round(n);
  return v % 2 === 0 ? v : v + 1;
}

/**
 * FFmpeg's atempo filter only accepts 0.5–2.0 per instance, and only a literal
 * float (never an expression like "1/2"). Anything outside that range has to be
 * chained: 4x becomes atempo=2.0,atempo=2.0.
 */
function atempoChain(speed) {
  let s = clamp(speed, 0.25, 8);
  const parts = [];
  while (s > 2.0) { parts.push('atempo=2.0'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s *= 2; }
  parts.push(`atempo=${s.toFixed(6)}`);
  return parts.join(',');
}

/**
 * Detect an audio track before applying any -filter:a / -af, otherwise FFmpeg
 * aborts with "Stream specifier ':a' matches no streams".
 */
function videoHasAudio(blob) {
  return new Promise((resolve) => {
    try {
      const el = document.createElement('video');
      el.preload = 'metadata';
      const url = URL.createObjectURL(blob);
      const done = (result) => {
        URL.revokeObjectURL(url);
        el.removeAttribute('src');
        resolve(result);
      };
      const timer = setTimeout(() => done(true), 3000); // assume audio if unknown
      el.onloadedmetadata = () => {
        clearTimeout(timer);
        const tracks =
          el.mozHasAudio ||
          Boolean(el.webkitAudioDecodedByteCount) ||
          Boolean(el.audioTracks && el.audioTracks.length);
        done(Boolean(tracks));
      };
      el.onerror = () => { clearTimeout(timer); done(true); };
      el.src = url;
    } catch {
      resolve(true);
    }
  });
}

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
