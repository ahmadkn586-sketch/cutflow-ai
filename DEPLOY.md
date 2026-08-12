# Deploy CutFlow AI to Vercel

## Quick Deploy (2 minutes)

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click "Add New Project"
3. Select your `cutflow-ai` repository
4. Click "Deploy" (settings are already configured)
5. Done! You'll get a URL like `cutflow-ai.vercel.app`

## Get Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click "Create API Key"
3. Copy the key (you'll paste it into the app)

## Use the App

1. Open your Vercel URL
2. Paste your Gemini API key
3. Upload a video
4. Start chatting: "make it cinematic", "speed up 2x", "add blur", etc.

## What's New

- ✅ Client-side video processing (FFmpeg in browser)
- ✅ No file uploads to server
- ✅ Faster processing
- ✅ Free hosting on Vercel
- ✅ Free AI with Gemini

## Troubleshooting

**Video processing fails?**
- Make sure you're using Chrome or Edge (best WebAssembly support)
- Try smaller videos first (< 100MB)

**API errors?**
- Check that your Gemini API key is valid
- Make sure you have internet connection for AI calls

**Slow processing?**
- Video processing happens in your browser
- Complex edits on long videos take time
- This is normal and free!
