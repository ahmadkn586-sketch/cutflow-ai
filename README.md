# CutFlow AI

Edit videos with natural language. Upload a video and say things like "make it cinematic" or "speed up 2x" — the AI understands what you want and FFmpeg processes it right in your browser.

## Features

- Chat-based video editing
- Runs entirely in browser (no server upload needed)
- Free Groq AI integration (Llama 3.3)
- Client-side FFmpeg processing
- Apple-style minimal UI

## Deploy to Vercel

1. Fork this repo
2. Go to [vercel.com](https://vercel.com) and import your fork
3. Deploy!

## Setup

1. Get a free Groq API key from [console.groq.com](https://console.groq.com)
2. Paste it when prompted in the app
3. Upload a video and start editing

## Tech Stack

- Frontend: Vanilla HTML/CSS/JS
- Video Processing: FFmpeg.wasm (runs in browser)
- AI: Groq (Llama 3.3)
- Hosting: Vercel (serverless)
