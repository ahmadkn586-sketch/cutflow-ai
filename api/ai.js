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
  const ALLOWED_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  const selectedModel = ALLOWED_MODELS.includes(model) ? model : ALLOWED_MODELS[0];

  try {
    const prompt = `You are an AI video editor assistant. The user wants to edit a video.

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

Respond with ONLY a valid JSON object (no markdown, no explanation outside JSON):
{
  "operation": "operation_name",
  "parameters": {},
  "description": "Brief description of what this edit does",
  "response": "Friendly casual message to the user about what you did"
}

Be specific with parameters.`;

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
