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

  const { command, apiKey, model } = req.body;

  if (!command) {
    return res.status(400).json({ error: 'Command is required' });
  }

  if (!apiKey) {
    return res.status(400).json({ error: 'API key is required' });
  }

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
      `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.5-flash'}:generateContent?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 2048,
        }
      },
      { timeout: 60000 }
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    
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

    res.status(200).json({
      success: true,
      result
    });

  } catch (error) {
    console.error('API error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: error.response?.data?.error?.message || error.message 
    });
  }
};
