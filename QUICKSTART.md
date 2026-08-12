# 🚀 CutFlow AI - Quick Start Guide

## What You Just Got

A full-stack AI video editor that lets you edit videos using natural language chat. Think of it like having a video editor that understands what you want.

## Setup (2 minutes)

### Step 1: Install Dependencies ✅

```bash
cd ai-video-editor/server
npm install
```

### Step 2: Start the Server ✅

```bash
npm start
```

**That's it!** Open your browser to `http://localhost:3001`

## Configure Your AI Model

The editor needs an AI model to understand your commands. You have options:

### Option A: Use Ollama (Free, Local, Recommended)

1. Download Ollama from [ollama.ai](https://ollama.ai)
2. Install and run it
3. Pull a model:
   ```bash
   ollama pull llama2
   ```
4. In CutFlow AI, click the **Settings** (gear icon)
5. Set:
   - **Endpoint**: `http://localhost:11434/api/generate`
   - **Model**: `llama2`
   - **Token**: (leave empty)

### Option B: Use Your GitHub Token

1. Click **Settings** (gear icon)
2. Enter your AI endpoint details:
   - **Endpoint**: Your model's API URL
   - **Model**: Your model name
   - **Token**: Your GitHub token

### Option C: Use OpenAI

1. Get API key from [OpenAI](https://platform.openai.com)
2. In Settings:
   - **Endpoint**: `https://api.openai.com/v1/chat/completions`
   - **Model**: `gpt-4` or `gpt-3.5-turbo`
   - **Token**: Your API key

## How to Use

1. **Upload Video**: Drag & drop any video file onto the upload area
2. **Chat**: Type what you want to do in the chat panel on the right
3. **Watch**: The AI processes your command and edits the video
4. **Preview**: See the result in the video player
5. **Export**: Click "Export" to download your edited video

## Example Commands to Try

```
"Add stylish captions with white text"
"Apply a cinematic color grade"
"Trim the first 5 seconds"
"Speed up the video to 2x"
"Add a blur effect"
"Crop to 16:9 aspect ratio"
"Make it black and white"
"Add a vintage filter"
"Increase volume to 150%"
"Slow motion at 0.5x"
```

## What's Included

✅ **Video Upload & Preview**
✅ **Chat Interface** - Talk to your AI editor
✅ **AI Command Processing** - Natural language understanding
✅ **FFmpeg Video Processing** - Professional-grade editing
✅ **Real-time Updates** - WebSocket for instant feedback
✅ **20+ Edit Operations** - Captions, effects, cuts, speed, crop, etc.
✅ **Timeline** - Visual representation of your video
✅ **Export** - Download your final video
✅ **Settings Panel** - Configure your AI model
✅ **Modern UI** - Dark theme, smooth animations

## Architecture

```
Frontend (Port 3001)
├── HTML/CSS/JS
├── Video Player
├── Chat Interface
└── Timeline

Backend (Node.js + Express)
├── Video Upload (Multer)
├── AI Integration (Axios)
├── Video Processing (FFmpeg)
└── Real-time Updates (WebSocket)

AI Model (Your Choice)
├── Ollama (local)
├── OpenAI API
├── GitHub Models
└── Any OpenAI-compatible endpoint
```

## Troubleshooting

### "AI command error: Failed to parse AI response"
- Make sure your AI model is running
- Check the endpoint URL in Settings
- Try a simpler command first

### "Upload failed"
- Check file size (should be reasonable)
- Make sure the uploads folder has write permissions
- Try a different video format (MP4, MOV, WebM work best)

### "Connection error"
- Make sure the server is running (`npm start`)
- Check if port 3001 is available
- Restart the server

## What's Next?

The editor is fully functional! Here are some ideas to extend it:

1. **Add Speech-to-Text**: Integrate Whisper for automatic captions
2. **Multi-track Timeline**: Add support for multiple video/audio tracks
3. **Undo/Redo**: Track edit history and allow reverting
4. **Templates**: Pre-built edit sequences
5. **Batch Processing**: Apply the same edits to multiple videos
6. **Export Presets**: YouTube, TikTok, Instagram optimized exports
7. **Plugin System**: Let users add custom effects

## Need Help?

- Check the full README.md for detailed documentation
- Look at the code - it's well-commented
- The AI endpoint is configurable - use whatever model you want

## The Token Thing

You mentioned "token like GitHub" - this is perfect! The Settings panel accepts:
- **API Endpoint**: Where your AI model lives
- **Model Name**: Which model to use
- **Token**: Your authentication token

Just plug in your credentials and you're good to go!

---

**You're all set! Upload a video and start chatting with your AI editor.** 🎬✨
