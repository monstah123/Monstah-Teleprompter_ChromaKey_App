/**
 * Gemini AI Script Integration Utility
 * Performs client-side serverless operations to polish and optimize
 * teleprompter scripts using Google Gemini 2.5 Flash model.
 */
export async function polishScriptWithGemini(apiKey, currentScript, toneOption) {
  if (!apiKey) {
    throw new Error('Please enter your Google Gemini API Key first.');
  }
  if (!currentScript.trim()) {
    throw new Error('The script editor is empty. Please write some text to polish.');
  }

  // Pre-configured instruction prompt strategies
  let systemPrompt = '';
  switch (toneOption) {
    case 'professional':
      systemPrompt = `You are a professional speechwriter. Polish the following script to make it sound highly professional, eloquent, authoritative, and clean, while maintaining its original message. 
      IMPORTANT: Return ONLY the polished script text. Do NOT include any introductions, meta explanations, bracketed comments, conversational notes, or markdown headers. Return pure speakable text only.`;
      break;
    case 'tiktok':
      systemPrompt = `You are an expert social media scriptwriter. Condense and restructure the following script to fit a high-energy, fast-paced 30-second TikTok, Instagram Reel, or YouTube Short. 
      Hook the audience in the first 2 seconds, keep sentences short and punchy, and include a clear call to action. 
      IMPORTANT: Return ONLY the raw script lines to be spoken. Do NOT include scene descriptions, camera directions, sound effect brackets, text overlays, or headers. Return pure speakable text.`;
      break;
    case 'dramatic':
      systemPrompt = `You are an expert public speaker. Restructure the following teleprompter script to add clear dramatic pacing, capitalise critical words for vocal emphasis, and insert pacing guides like [Breathe] or [Pause] where natural silence belongs to create a powerful delivery. 
      IMPORTANT: Return ONLY the speakable script. Include ONLY the bracketed delivery cues and the speakable text. Do NOT add meta commentary or introductions.`;
      break;
    case 'persuasive':
      systemPrompt = `You are a persuasive master copywriter. Rewrite this script to be highly persuasive, warm, friendly, conversational, and direct. Break down complex jargon and build an immediate personal connection. 
      IMPORTANT: Return ONLY the rewritten script text. Do NOT include metadata, prefaces, or markup headers.`;
      break;
    default:
      systemPrompt = `Rewrite this script to polish the phrasing for teleprompter speaking. Return ONLY the text script content.`;
  }

  const payload = {
    contents: [
      {
        parts: [
          {
            text: `${systemPrompt}\n\nOriginal Script:\n"""\n${currentScript}\n"""`
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.7
    }
  };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json();
      const apiErrorMessage = errorData.error?.message || response.statusText;
      throw new Error(`Gemini API Error: ${apiErrorMessage}`);
    }

    const data = await response.json();
    const polishedText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!polishedText) {
      throw new Error('Gemini API returned an empty response. Please verify the prompt.');
    }

    // Clean up any stray markdown fences (Gemini sometimes returns markdown codeblocks)
    return polishedText
      .replace(/^```[a-zA-Z]*\n/, '') // Remove starting fence
      .replace(/\n```$/, '')         // Remove ending fence
      .trim();

  } catch (error) {
    console.error('Gemini API fetch error:', error);
    throw error;
  }
}
