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
async function initFFmpeg() {
  if (ffmpeg) return ffmpeg;
  
  ffmpeg = new FFmpegWASM.FFmpeg();
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd';
  await ffmpeg.load({
    coreURL: `${baseURL}/ffmpeg-core.js`,
    wasmURL: `${baseURL}/ffmpeg-core.wasm`,
  });
  
  return ffmpeg;
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
  
  // Initialize FFmpeg in background
  initFFmpeg().catch(err => {
    console.error('FFmpeg init failed:', err);
    addMessage('ai', 'Warning: Video processing may not work. Your browser might not support WebAssembly.');
  });
  
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

    const aiData = await aiResponse.json();

    if (!aiData.success) {
      throw new Error(aiData.error || 'AI command failed');
    }

    addMessage('ai', aiData.result.response || `Applying: ${aiData.result.description}`);

    // Process video with FFmpeg
    showProcessing('Processing video...');
    await processVideo(aiData.result);

  } catch (err) {
    addMessage('ai', 'Error: ' + err.message);
  } finally {
    hideProcessing();
    sendBtn.disabled = false;
    isProcessing = false;
  }
}

async function processVideo(operation) {
  try {
    const ffmpeg = await initFFmpeg();
    
    // Write input file
    const inputName = 'input.mp4';
    const outputName = 'output.mp4';
    
    const fileData = await currentVideoBlob.arrayBuffer();
    await ffmpeg.writeFile(inputName, new Uint8Array(fileData));

    // Build FFmpeg command based on operation
    const args = ['-i', inputName];
    
    switch (operation.operation) {
      case 'trim_video':
        args.push('-ss', operation.parameters.start || 0);
        args.push('-t', operation.parameters.duration || 10);
        break;
        
      case 'resize_video':
        args.push('-vf', `scale=${operation.parameters.width}:${operation.parameters.height}`);
        break;
        
      case 'crop_video':
        const { width, height, x = 0, y = 0 } = operation.parameters;
        args.push('-vf', `crop=${width}:${height}:${x}:${y}`);
        break;
        
      case 'adjust_speed':
        const speed = operation.parameters.speed || 1;
        args.push('-filter:v', `setpts=${1/speed}*PTS`);
        args.push('-filter:a', `atempo=${speed}`);
        break;
        
      case 'slow_motion':
        const factor = operation.parameters.factor || 2;
        args.push('-filter:v', `setpts=${factor}*PTS`);
        args.push('-filter:a', `atempo=1/${factor}`);
        break;
        
      case 'speed_up':
        const speedUp = operation.parameters.factor || 2;
        args.push('-filter:v', `setpts=1/${speedUp}*PTS`);
        args.push('-filter:a', `atempo=${speedUp}`);
        break;
        
      case 'mute_audio':
        args.push('-an');
        break;
        
      case 'adjust_volume':
        const level = operation.parameters.level || 1;
        args.push('-af', `volume=${level}`);
        break;
        
      case 'color_grade':
        const grade = operation.parameters.grade || 'warm';
        const gradeFilters = {
          warm: 'colorbalance=rs=0.3:gs=0:bs=-0.3',
          cool: 'colorbalance=rs=-0.3:gs=0:bs=0.3',
          vintage: 'curves=vintage',
          cinematic: 'curves=preset=lighter'
        };
        args.push('-vf', gradeFilters[grade] || gradeFilters.warm);
        break;
        
      case 'add_effect':
      case 'add_filter':
        const effect = operation.parameters.effect || operation.parameters.filter || 'blur';
        const effectFilters = {
          blur: 'boxblur=5:1',
          sharpen: 'unsharp=5:5:1.5',
          grayscale: 'hue=s=0',
          sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
          vintage: 'curves=vintage',
          emboss: 'convolution=-2 -1 0 -1 1 1 0 1 2',
          edge: 'edgedetect=low=0.1:high=0.4'
        };
        args.push('-vf', effectFilters[effect] || effectFilters.blur);
        break;
        
      default:
        throw new Error(`Unknown operation: ${operation.operation}`);
    }
    
    args.push(outputName);

    // Run FFmpeg
    await ffmpeg.exec(args);

    // Read output
    const data = await ffmpeg.readFile(outputName);
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
    throw new Error('Video processing failed: ' + err.message);
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
  if (!currentVideoBlob) return;
  
  const a = document.createElement('a');
  a.href = URL.createObjectURL(currentVideoBlob);
  a.download = `${projectName.textContent}_edited.mp4`;
  a.click();
});

// Helpers
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
