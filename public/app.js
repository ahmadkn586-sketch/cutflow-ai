// State
let currentProject = null;
let isProcessing = false;

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
    uploadVideo(file);
  }
});

videoUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) uploadVideo(file);
});

async function uploadVideo(file) {
  const formData = new FormData();
  formData.append('video', file);
  formData.append('name', file.name.replace(/\.[^/.]+$/, ''));

  try {
    showProcessing('Uploading...');
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (data.success) {
      currentProject = data.project;
      switchToEditor();
      videoPlayer.src = data.project.videoPath;
      projectName.textContent = data.project.name;
      hideProcessing();
    }
  } catch (err) {
    hideProcessing();
    addMessage('ai', 'Upload failed: ' + err.message);
  }
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
  if (!text || isProcessing || !currentProject) return;

  addMessage('user', text);
  chatInput.value = '';
  chatInput.style.height = 'auto';
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/ai/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: currentProject.id,
        command: text
      })
    });

    const data = await res.json();

    if (data.success) {
      addMessage('ai', data.result.response || `Applied: ${data.result.description}`);
      
      if (data.output) {
        const currentTime = videoPlayer.currentTime;
        videoPlayer.src = data.output;
        videoPlayer.currentTime = currentTime;
        currentProject.videoPath = data.output;
      }
    } else {
      addMessage('ai', 'Error: ' + data.error);
    }
  } catch (err) {
    addMessage('ai', 'Error: ' + err.message);
  }

  sendBtn.disabled = false;
  chatInput.focus();
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
  loadAIConfig();
});

modalClose.addEventListener('click', () => {
  settingsModal.style.display = 'none';
});

document.querySelector('.modal-overlay').addEventListener('click', () => {
  settingsModal.style.display = 'none';
});

async function loadAIConfig() {
  try {
    const res = await fetch('/api/config/ai');
    const config = await res.json();
    document.getElementById('ai-endpoint').value = config.endpoint || '';
    document.getElementById('ai-model').value = config.model || '';
    document.getElementById('ai-token').value = config.token || '';
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

document.getElementById('save-ai-config').addEventListener('click', async () => {
  const config = {
    endpoint: document.getElementById('ai-endpoint').value,
    model: document.getElementById('ai-model').value,
    token: document.getElementById('ai-token').value || null
  };

  try {
    await fetch('/api/config/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    settingsModal.style.display = 'none';
    addMessage('ai', 'Settings saved');
  } catch (err) {
    addMessage('ai', 'Failed to save settings: ' + err.message);
  }
});

// Export
document.getElementById('export-btn').addEventListener('click', () => {
  if (!currentProject) return;
  const a = document.createElement('a');
  a.href = currentProject.videoPath;
  a.download = `${currentProject.name}_edited.mp4`;
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

// WebSocket for real-time updates
let ws;
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleWSMessage(data);
  };
  
  ws.onclose = () => {
    setTimeout(connectWebSocket, 3000);
  };
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'processing':
      showProcessing(data.message || 'Processing...');
      break;
    case 'progress':
      progressFill.style.width = `${data.percent}%`;
      break;
    case 'complete':
      hideProcessing();
      break;
    case 'error':
      hideProcessing();
      addMessage('ai', 'Error: ' + data.message);
      break;
  }
}

connectWebSocket();
