# 🎬 CutFlow AI — Video Editor

Edit videos with natural language. Just tell the AI what you want — powered by Google Gemini (free!).

## ⚡ Quick Start

```bash
cd ai-video-editor/server
npm install
npm start
```

Then open **http://localhost:3001** in your browser.

## 🔑 Setup Gemini (30 seconds — FREE!)

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click **"Create API Key"** — no credit card needed
3. Copy the key (starts with `AIzaSy...`)
4. In CutFlow AI, click **⚙️ Settings** → paste your key → Save

That's it! Gemini 2.5 Flash gives you **10 requests/min, 250/day** for free.

## 💬 How to Use

1. **Upload** a video (drag & drop)
2. **Chat** with the AI editor on the right
3. **Watch** it edit your video
4. **Export** the result

### Try These Commands

```
"Add stylish white captions at the bottom"
"Apply a cinematic warm color grade"  
"Trim the first 5 seconds"
"Speed up to 2x"
"Add a blur effect"
"Make it black and white"
"Crop to a square"
"Mute the audio"
"Slow motion at half speed"
"Add a vintage filter"
```

## 🛠️ Features

- 💬 **Chat-to-Edit** — describe edits in plain English
- 🎨 **Color Grades** — warm, cool, cinematic, vintage
- ✂️ **Smart Cuts** — trim, crop, resize
- ⚡ **Speed Control** — slow-mo, speed up
- 📝 **Captions** — styled text overlays
- 🌫️ **Effects** — blur, sharpen, grayscale, sepia, emboss
- 🔊 **Audio** — mute, volume, extract audio
- 🤖 **Multi-Provider** — Gemini (free), OpenAI, or custom endpoint
- 📐 **Timeline** — visual video player with seek

## 🏗️ Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Vanilla HTML/CSS/JS |
| Backend | Node.js + Express |
| Video | FFmpeg (fluent-ffmpeg) |
| Real-time | WebSocket |
| AI | Google Gemini 2.5 Flash (free) |

## 🤖 AI Providers

| Provider | Free? | Setup |
|----------|-------|-------|
| **Google Gemini** | ✅ Yes (250/day) | [Get API key](https://aistudio.google.com/apikey) |
| OpenAI | ❌ Paid | OpenAI platform |
| Custom | Any | Your own endpoint |

## 📁 Project Structure

```
ai-video-editor/
├── server/
│   ├── index.js            # Backend: Express + FFmpeg + AI
│   └── package.json
├── public/
│   ├── index.html          # Main UI
│   ├── app.js              # Frontend logic
│   └── styles/main.css     # Dark theme styling
└── README.md
```
