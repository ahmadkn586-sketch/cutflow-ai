import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

// Set ffmpeg and ffprobe paths from static packages
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));
app.use('/output', express.static(path.join(__dirname, '../public/output')));
app.use('/styles', express.static(path.join(__dirname, '../public/styles')));
app.use('/app.js', express.static(path.join(__dirname, '../public/app.js')));
app.use('/test.html', express.static(path.join(__dirname, '../public/test.html')));
app.use(express.static(path.join(__dirname, '../public')));

// Serve index.html for root
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, '../public/index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('index.html not found');
  }
});

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../public/uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// In-memory storage for projects
const projects = new Map();

// WebSocket connections
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function broadcast(message) {
  const data = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
}

// ===== AI Configuration =====
let aiConfig = {
  provider: 'gemini',           // 'gemini' | 'openai' | 'custom'
  apiKey: '',                   // API key (for Gemini: the free key from AI Studio)
  model: 'gemini-2.5-flash',    // Gemini model
  endpoint: '',                 // Custom endpoint (only for 'custom' provider)
};

// ===== Gemini API Call =====
async function callGemini(prompt) {
  const model = aiConfig.model || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${aiConfig.apiKey}`;

  const response = await axios.post(url, {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 2048,
    }
  }, {
    timeout: 60000,
    headers: { 'Content-Type': 'application/json' }
  });

  // Extract text from Gemini response
  const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const blockReason = response.data?.candidates?.[0]?.finishReason;
    throw new Error(`Gemini returned no content. Reason: ${blockReason || 'unknown'}`);
  }
  return text;
}

// ===== OpenAI-compatible API Call =====
async function callOpenAI(prompt) {
  const url = aiConfig.endpoint || 'https://api.openai.com/v1/chat/completions';
  
  const response = await axios.post(url, {
    model: aiConfig.model || 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: 'You are an AI video editor assistant. Always respond with valid JSON.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.3,
    max_tokens: 2048,
  }, {
    timeout: 60000,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${aiConfig.apiKey}`
    }
  });

  return response.data?.choices?.[0]?.message?.content || response.data?.choices?.[0]?.text;
}

// ===== Custom Endpoint API Call =====
async function callCustom(prompt) {
  if (!aiConfig.endpoint) throw new Error('No custom endpoint configured');
  
  const response = await axios.post(aiConfig.endpoint, {
    model: aiConfig.model,
    prompt: prompt,
    stream: false
  }, {
    timeout: 60000,
    headers: aiConfig.apiKey ? { 'Authorization': `Bearer ${aiConfig.apiKey}` } : {},
  });

  return response.data.response || response.data.choices?.[0]?.text || response.data.message?.content;
}

// ===== Unified AI Call =====
async function callAI(prompt) {
  switch (aiConfig.provider) {
    case 'gemini':
      return await callGemini(prompt);
    case 'openai':
      return await callOpenAI(prompt);
    case 'custom':
      return await callCustom(prompt);
    default:
      throw new Error(`Unknown provider: ${aiConfig.provider}`);
  }
}

// ===== Upload video endpoint =====
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const projectId = uuidv4();
  const project = {
    id: projectId,
    name: req.body.name || 'Untitled Project',
    video: req.file.filename,
    videoPath: `/uploads/${req.file.filename}`,
    edits: [],
    createdAt: new Date().toISOString()
  };

  projects.set(projectId, project);
  res.json({ success: true, project });
});

// Get project details
app.get('/api/project/:id', (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  res.json(project);
});

// Update AI configuration
app.post('/api/config/ai', (req, res) => {
  aiConfig = { ...aiConfig, ...req.body };
  res.json({ success: true, config: aiConfig });
});

// Get AI configuration (never send the full API key back)
app.get('/api/config/ai', (req, res) => {
  res.json({
    provider: aiConfig.provider,
    model: aiConfig.model,
    endpoint: aiConfig.endpoint,
    hasApiKey: !!aiConfig.apiKey,
    apiKeyPreview: aiConfig.apiKey ? aiConfig.apiKey.slice(0, 8) + '...' : ''
  });
});

// Test AI connection
app.post('/api/config/ai/test', async (req, res) => {
  const testConfig = req.body;
  
  try {
    // Temporarily use test config
    const oldConfig = { ...aiConfig };
    aiConfig = { ...aiConfig, ...testConfig };

    const response = await callAI('Respond with exactly: {"test": "success"}');
    
    // Restore config
    aiConfig = oldConfig;

    res.json({ success: true, message: 'Connection successful!', response: response.slice(0, 100) });
  } catch (error) {
    console.error('AI test error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Connection failed',
      details: error.response?.data?.error?.message || error.response?.data?.error?.message || ''
    });
  }
});

// ===== Process AI command =====
app.post('/api/ai/command', async (req, res) => {
  const { projectId, command } = req.body;
  const project = projects.get(projectId);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  if (!aiConfig.apiKey) {
    return res.status(400).json({ error: 'No API key configured. Open Settings and add your Gemini API key.' });
  }

  try {
    broadcast({ type: 'processing', message: 'AI is thinking...' });

    // Get video metadata for context
    let videoInfo = {};
    try {
      const fullPath = path.join(__dirname, '../public', project.videoPath);
      videoInfo = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(fullPath, (err, metadata) => {
          if (err) return resolve({});
          resolve({
            duration: Math.round(metadata.format.duration || 0),
            width: metadata.streams?.[0]?.width,
            height: metadata.streams?.[0]?.height,
            fps: metadata.streams?.[0]?.r_frame_rate,
          });
        });
      });
    } catch (e) {}

    const previousEdits = project.edits.slice(-5).map(e => `${e.operation}: ${e.description}`).join('\n');

    const prompt = `You are an AI video editor assistant. The user wants to edit a video.

VIDEO INFO:
- Duration: ${videoInfo.duration || 'unknown'} seconds
- Resolution: ${videoInfo.width || '?'}x${videoInfo.height || '?'}
- FPS: ${videoInfo.fps || 'unknown'}

PREVIOUS EDITS (most recent):
${previousEdits || 'None yet'}

USER COMMAND: "${command}"

AVAILABLE OPERATIONS AND THEIR PARAMETERS:

1. trim_video - Cut the video to a specific range
   Parameters: { "start": 0, "duration": 10 }

2. add_effect - Apply a visual effect
   Parameters: { "effect": "blur|sharpen|brightness|contrast|saturation|grayscale|sepia|vintage", "intensity": 50 }

3. adjust_speed - Change playback speed
   Parameters: { "speed": 2.0 }

4. crop_video - Crop to specific dimensions
   Parameters: { "width": 1280, "height": 720, "x": 0, "y": 0 }

5. resize_video - Resize to specific dimensions
   Parameters: { "width": 1920, "height": 1080 }

6. mute_audio - Remove all audio

7. adjust_volume - Change audio volume
   Parameters: { "level": 1.5 }

8. color_grade - Apply color grading
    Parameters: { "grade": "warm|cool|cinematic|vintage" }

9. add_filter - Apply a video filter
    Parameters: { "filter": "blur|sharpen|emboss|edge" }

10. slow_motion - Slow down video
    Parameters: { "factor": 2 }

11. speed_up - Speed up video
    Parameters: { "factor": 2 }

12. extract_audio - Extract the audio track

Respond with ONLY a valid JSON object (no markdown, no explanation outside JSON):
{
  "operation": "operation_name",
  "parameters": {},
  "description": "Brief description of what this edit does",
  "response": "Friendly casual message to the user about what you did"
}

If the command is unclear, still pick the closest operation and explain in "response". Be specific with parameters.`;

    // Call AI
    const responseText = await callAI(prompt);
    
    // Parse JSON from response
    let aiResult;
    try {
      // Clean up markdown code blocks if present
      let cleaned = responseText.trim();
      cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
      
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        aiResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Parse error. Raw response:', responseText);
      throw new Error(`AI response could not be parsed. Try rephrasing your command.`);
    }

    broadcast({ type: 'executing', operation: aiResult.operation, description: aiResult.description });

    // Execute the operation
    const result = await executeOperation(project, aiResult);

    project.edits.push({
      id: uuidv4(),
      operation: aiResult.operation,
      parameters: aiResult.parameters,
      description: aiResult.description,
      output: result.outputFile,
      timestamp: new Date().toISOString()
    });

    projects.set(projectId, project);

    broadcast({ type: 'complete', message: aiResult.response || 'Edit applied successfully!' });

    res.json({
      success: true,
      result: aiResult,
      output: result.outputFile
    });

  } catch (error) {
    console.error('AI command error:', error.response?.data || error.message);
    const errorMsg = error.response?.data?.error?.message || error.message;
    broadcast({ type: 'error', message: errorMsg });
    res.status(500).json({ error: errorMsg });
  }
});

// ===== Execute video operation =====
async function executeOperation(project, operation) {
  const inputPath = path.join(__dirname, '../public', project.videoPath);
  const outputPath = path.join(__dirname, '../public/output', `${uuidv4()}.mp4`);

  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath);

    switch (operation.operation) {
      case 'add_captions':
      case 'add_text_overlay': {
        // drawtext filter not available in static ffmpeg build
        return reject(new Error('Text overlays require a full FFmpeg installation with drawtext support. This feature is not available in the current setup.'));
      }

      case 'trim_video':
        command = command
          .setStartTime(operation.parameters.start || 0)
          .duration(operation.parameters.duration || 10);
        break;

      case 'add_effect': {
        const effects = {
          'blur': 'boxblur=5:1',
          'sharpen': 'unsharp=5:5:1.5',
          'brightness': `eq=brightness=${(operation.parameters.intensity || 50) / 100}`,
          'contrast': `eq=contrast=${1 + (operation.parameters.intensity || 50) / 200}`,
          'saturation': `eq=saturation=${1 + (operation.parameters.intensity || 50) / 100}`,
          'grayscale': 'hue=s=0',
          'sepia': 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
          'vintage': 'curves=vintage'
        };
        const effectFilter = effects[operation.parameters.effect] || effects.blur;
        command = command.videoFilters(effectFilter);
        break;
      }

      case 'adjust_speed': {
        const speed = operation.parameters.speed || 1;
        command = command.videoFilters(`setpts=${1/speed}*PTS`);
        if (speed >= 0.5 && speed <= 2.0) {
          command = command.audioFilters(`atempo=${speed}`);
        } else if (speed > 2.0) {
          // Chain atempo filters for speeds > 2x
          command = command.audioFilters(`atempo=2.0,atempo=${speed/2}`);
        } else {
          command = command.audioFilters(`atempo=0.5,atempo=${speed/0.5}`);
        }
        break;
      }

      case 'crop_video':
        command = command.videoFilters([
          `crop=${operation.parameters.width}:${operation.parameters.height}:${operation.parameters.x || 0}:${operation.parameters.y || 0}`
        ]);
        break;

      case 'resize_video':
        command = command.videoFilters([
          `scale=${operation.parameters.width || 1920}:${operation.parameters.height || 1080}`
        ]);
        break;

      case 'extract_audio': {
        const audioPath = path.join(__dirname, '../public/output', `${uuidv4()}.mp3`);
        command = command.noVideo().output(audioPath);
        break;
      }

      case 'mute_audio':
        command = command.noAudio();
        break;

      case 'adjust_volume':
        command = command.audioFilters([
          `volume=${operation.parameters.level || 1.0}`
        ]);
        break;

      case 'color_grade': {
        const grades = {
          'warm': 'colorbalance=rs=0.3:gs=0:bs=-0.3:rm=0.2:gm=0:bm=-0.2',
          'cool': 'colorbalance=rs=-0.3:gs=0:bs=0.3:rm=-0.2:gm=0:bm=0.2',
          'cinematic': 'curves=preset=lighter',
          'vintage': 'curves=vintage'
        };
        const gradeFilter = grades[operation.parameters.grade] || grades.warm;
        command = command.videoFilters(gradeFilter);
        break;
      }

      case 'add_filter': {
        const filters = {
          'blur': 'boxblur=5:1',
          'sharpen': 'unsharp=5:5:1.5',
          'emboss': 'convolution=-2 -1 0 -1 1 1 0 1 2',
          'edge': 'edgedetect=low=0.1:high=0.4'
        };
        const filterEffect = filters[operation.parameters.filter] || filters.blur;
        command = command.videoFilters(filterEffect);
        break;
      }

      case 'slow_motion': {
        const slowFactor = operation.parameters.factor || 2;
        command = command.videoFilters(`setpts=${slowFactor}*PTS`);
        if (slowFactor <= 2) {
          command = command.audioFilters(`atempo=${1/slowFactor}`);
        } else {
          command = command.audioFilters(`atempo=0.5,atempo=${1/(slowFactor/2)}`);
        }
        break;
      }

      case 'speed_up': {
        const fastFactor = operation.parameters.factor || 2;
        command = command.videoFilters(`setpts=${1/fastFactor}*PTS`);
        if (fastFactor <= 2) {
          command = command.audioFilters(`atempo=${fastFactor}`);
        } else {
          command = command.audioFilters(`atempo=2.0,atempo=${fastFactor/2}`);
        }
        break;
      }

      default:
        return reject(new Error(`Unknown operation: ${operation.operation}`));
    }

    command
      .output(outputPath)
      .on('progress', (progress) => {
        broadcast({ type: 'progress', percent: progress.percent || 0 });
      })
      .on('end', () => {
        resolve({ outputFile: `/output/${path.basename(outputPath)}` });
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err.message);
        reject(err);
      })
      .run();
  });
}

// Test endpoint - bypass AI and execute operation directly
app.post('/api/test/operation', async (req, res) => {
  const { projectId, operation } = req.body;
  const project = projects.get(projectId);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  try {
    broadcast({ type: 'executing', operation: operation.operation, description: operation.description });
    const result = await executeOperation(project, operation);

    project.edits.push({
      id: uuidv4(),
      operation: operation.operation,
      parameters: operation.parameters,
      description: operation.description,
      output: result.outputFile,
      timestamp: new Date().toISOString()
    });

    projects.set(projectId, project);
    broadcast({ type: 'complete', message: 'Operation completed!' });

    res.json({
      success: true,
      result: operation,
      output: result.outputFile
    });
  } catch (error) {
    console.error('Test operation error:', error.message);
    broadcast({ type: 'error', message: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get video metadata
app.get('/api/video/metadata', async (req, res) => {
  const { path: videoPath } = req.query;
  const fullPath = path.join(__dirname, '../public', videoPath);

  ffmpeg.ffprobe(fullPath, (err, metadata) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({
      duration: metadata.format.duration,
      size: metadata.format.size,
      bitrate: metadata.format.bit_rate,
      streams: metadata.streams
    });
  });
});

// 404 handler - MUST BE LAST
app.use((req, res) => {
  console.log(`404: ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Not found', path: req.path });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 CutFlow AI running on http://0.0.0.0:${PORT}`);
  console.log(`⚡ WebSocket ready for real-time updates`);
  console.log(`🤖 Default AI: Google Gemini 2.5 Flash (free tier)`);
});
