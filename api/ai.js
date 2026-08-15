const axios = require('axios');

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel usually parses JSON, but not when content-type is missing/odd
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }
  body = body || {};

  const { command, model } = body;

  // Prefer a server-side key. Falling back to the browser-supplied key keeps
  // the current UX working, but setting GROQ_API_KEY in Vercel means the key
  // never leaves the server.
  const apiKey = process.env.GROQ_API_KEY || body.apiKey;

  if (!command || typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ error: 'Command is required' });
  }

  if (command.length > 1000) {
    return res.status(400).json({ error: 'Command is too long (max 1000 characters)' });
  }

  if (!apiKey) {
    return res.status(400).json({ error: 'API key is required' });
  }

  // Only allow models this app actually supports
  // Optional clip context from the client (duration/size) improves parsing
  const meta = body.meta || {};
  const ctxLine = meta.duration
    ? `\nCLIP: ${Number(meta.duration).toFixed(1)}s long, ${meta.width || '?'}x${meta.height || '?'}, ${meta.hasAudio === false ? 'NO audio track' : 'has audio'}.\n`
    : '';

  const ALLOWED_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  const selectedModel = ALLOWED_MODELS.includes(model) ? model : ALLOWED_MODELS[0];

  try {
    const prompt = `You are the command parser for a browser video editor.
Convert the user's request into ONE operation.

USER COMMAND: "${command}"
${ctxLine}
AVAILABLE OPERATIONS (use these names exactly):

trim_video     { "start": seconds, "duration": seconds }   also accepts "end"
resize_video   { "width": px, "height": px }
crop_video     { "aspect": "9:16"|"1:1"|"4:5"|"16:9"|"4:3" }  or { width,height,x,y }
adjust_speed   { "speed": 2.0 }          2 = twice as fast, 0.5 = half
speed_up       { "factor": 2 }
slow_motion    { "factor": 2 }           2 = half speed
mute_audio     { }
adjust_volume  { "level": 1.5 }          1 = unchanged
color_grade    { "grade": "warm"|"cool"|"vintage"|"cinematic"|"teal"|"noir"|"dramatic"|"bright"|"faded" }
add_effect     { "effect": "blur"|"gblur"|"sharpen"|"grayscale"|"sepia"|"vintage"|"emboss"|"edge"|"negate"|"vignette"|"pixelate"|"noise"|"denoise"|"brightness"|"contrast"|"saturation", "intensity": 0-100 }
rotate         { "degrees": 90|180|270 }
flip           { "direction": "horizontal"|"vertical" }
fade           { "type": "in"|"out"|"both", "duration": seconds }
reverse        { }                       clips under 30s only
add_text       { "text": "...", "position": "top"|"middle"|"bottom", "size": px, "color": "white" }
change_fps     { "fps": 30 }
extract_audio  { }                       exports an mp3
to_gif         { "fps": 12, "width": 480 }   clips under 15s only
thumbnail      { "time": seconds }       exports a jpg
pad_video      { "aspect": "9:16"|"1:1"|"16:9" }   letterbox, no cropping
blur_background{ "aspect": "9:16" }      blurred fill behind the frame
scale_by       { "factor": 0.5 }         relative resize
zoom           { "factor": 1.2 }         punch in
add_border     { "size": 20, "color": "white" }
timelapse      { "factor": 8 }
boomerang      { }                       forward then reverse, <=15s
loop_video     { "count": 2 }
stabilize      { }                       reduces camera shake
hue_rotate     { "degrees": 90 }
normalize_audio{ }                       even out loudness
denoise_audio  { }                       remove hiss/background noise
fade_audio     { "type": "in"|"out"|"both", "duration": seconds }
compress       { "level": "medium"|"high" }   smaller file
aura_edit      { "style": "purple"|"blue"|"red"|"gold"|"green"|"pink"|"white"|"dark", "intensity": 10-100 }
               THE signature look: 9:16 + glow bloom + punchy colour + grain
aura           { "style": ..., "intensity": ... }   same look, keeps current framing
glow           { "intensity": 10-100 }   bloom only, no colour push
chroma_shift   { "intensity": 1-12 }     rgb split / glitch
shake          { "intensity": 10-100 }   handheld camera shake
punch_zoom     { "bpm": 120, "intensity": 10-100 }   zoom pulse on the beat
speed_ramp     { "at": 0.4, "slow": 2, "fast": 2 }   slow then snap fast
film_grain     { "intensity": 4-60 }
vhs            { }                       retro tape look

RULES
- Pick the single closest operation. Never invent an operation name.
- "make it pop"/"cinematic"/"film look" -> color_grade
- "for TikTok/Reels/Shorts/vertical" -> crop_video with aspect 9:16
- "for Instagram square" -> crop_video with aspect 1:1
- "smaller file"/"for WhatsApp"/"reduce size" -> compress
- "shaky"/"steady" -> stabilize
- "fit without cropping"/"letterbox" -> pad_video
- "aura edit"/"edit of me/him/her"/"make me an edit" -> aura_edit
- A colour before "aura" is the style: "purple aura" -> aura style purple
- Only ONE operation. The client handles multi-step commands itself.
- Omit parameters you are unsure about; sensible defaults are applied.
- "response" must be one short friendly sentence, no markdown.

Respond with ONLY this JSON:
{"operation":"","parameters":{},"description":"","response":""}`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: selectedModel,
        messages: [
          { role: 'system', content: 'You are a helpful video editing assistant. Always respond with valid JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
      },
      {
        timeout: 60000,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const text = response.data?.choices?.[0]?.message?.content;
    
    if (!text) {
      throw new Error('No response from AI');
    }

    // Parse JSON from response
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse AI response');
    }

    const result = JSON.parse(jsonMatch[0]);

    if (!result.operation) {
      throw new Error('AI did not return an operation. Try rephrasing your command.');
    }

    res.status(200).json({
      success: true,
      result
    });

  } catch (error) {
    const status = error.response?.status;
    const upstream = error.response?.data?.error?.message;

    // Never log the API key
    console.error('API error:', status || '', upstream || error.message);

    // Pass the real status through instead of flattening everything to 500,
    // so an invalid key reads as 401 rather than a generic server error.
    if (status === 401) {
      return res.status(401).json({ error: 'Invalid Groq API key. Check it in Settings.' });
    }
    if (status === 429) {
      return res.status(429).json({ error: 'Groq rate limit reached. Wait a moment and try again.' });
    }
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'AI request timed out. Try again.' });
    }

    res.status(status && status >= 400 && status < 600 ? status : 500).json({
      error: upstream || error.message || 'Unknown server error'
    });
  }
};
