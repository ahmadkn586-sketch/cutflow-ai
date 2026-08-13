# Deploy CutFlow AI to Vercel

## Quick Deploy (2 minutes)

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click "Add New Project"
3. Select your `cutflow-ai` repository
4. Click "Deploy" (settings are already configured)
5. Done! You'll get a URL like `cutflow-ai.vercel.app`

## Get Groq API Key

1. Go to [console.groq.com](https://console.groq.com)
2. Click "API Keys" then "Create API Key"
3. Copy the key (you'll paste it into the app)

## Use the App

1. Open your Vercel URL
2. Paste your Groq API key
3. Upload a video
4. Start chatting: "make it cinematic", "speed up 2x", "add blur", etc.

## What's New

- ✅ Client-side video processing (FFmpeg in browser)
- ✅ No file uploads to server
- ✅ Faster processing
- ✅ Free hosting on Vercel
- ✅ Free AI with Groq (Llama 3.3)

## Troubleshooting

**Video processing fails?**
- Make sure you're using Chrome or Edge (best WebAssembly support)
- Try smaller videos first (< 100MB)

**API errors?**
- Check that your Groq API key is valid
- Make sure you have internet connection for AI calls

**Slow processing?**
- Video processing happens in your browser
- Complex edits on long videos take time
- This is normal and free!

## Optional: keep your Groq key server-side

By default the app stores the Groq key in the browser's localStorage and sends
it to `/api/ai` with every request. That's fine for personal use, but the key is
visible to anyone using the app.

To keep it server-side instead:

1. In Vercel go to **Project → Settings → Environment Variables**
2. Add `GROQ_API_KEY` with your `gsk_...` key
3. Redeploy

When `GROQ_API_KEY` is set the server uses it and ignores whatever the browser
sends, so users never need to enter a key at all.
