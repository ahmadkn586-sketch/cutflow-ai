# CutFlow AI

AI-powered video editor with natural language commands. Edit videos by chatting — "make it cinematic", "speed up 2x", "add blur effect".

## Features

- Chat-based video editing
- Client-side FFmpeg processing (no server uploads)
- Free Gemini AI integration
- Effects: blur, sharpen, grayscale, sepia, vintage
- Color grading: warm, cool, cinematic, vintage
- Speed control: slow motion, speed up
- Trim, crop, resize
- Audio: mute, volume control

## How it works

1. Upload video (stays in your browser)
2. Chat with AI to describe edits
3. FFmpeg processes video client-side
4. Download result

## Deploy to Vercel

```bash
npm install
vercel
```

Or connect your GitHub repo at [vercel.com](https://vercel.com).

## Setup

1. Get a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Enter it on the landing page
3. Upload a video and start editing

## Tech Stack

- Frontend: Vanilla HTML/CSS/JS
- Video Processing: FFmpeg (WebAssembly)
- AI: Google Gemini
- Hosting: Vercel
