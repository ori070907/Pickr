// Pickr backend - calls OpenRouter securely
// API key is kept secret on the server (NEVER exposed to users)
 
export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'OPTIONS') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
 
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
 
  try {
    const { mode, images, occasion, extra } = req.body;
 
    if (!images || images.length === 0) {
      return res.status(400).json({ error: 'No images provided' });
    }
    if (!occasion) {
      return res.status(400).json({ error: 'No occasion provided' });
    }
 
    let messageContent = [];
    let promptText = '';
 
    if (mode === 'single') {
      messageContent.push({
        type: 'image_url',
        image_url: { url: images[0] }
      });
 
      promptText = `The user is deciding whether to wear this outfit to: ${occasion}.${extra ? ' Extra context: ' + extra : ''}
 
Respond ONLY in this JSON format (no markdown, no backticks):
{
  "verdict": "YES" | "NO" | "MAYBE",
  "verdict_label": "short punchy label",
  "reason": "2-3 sentences explaining if it works and why",
  "tips": ["tip 1", "tip 2", "tip 3"]
}
 
Be specific. Direct but kind.`;
    } else {
      images.forEach((img, idx) => {
        messageContent.push({ type: 'text', text: `Outfit ${idx + 1}:` });
        messageContent.push({
          type: 'image_url',
          image_url: { url: img }
        });
      });
 
      promptText = `The user has ${images.length} outfit options for: ${occasion}.${extra ? ' Extra context: ' + extra : ''}
 
Pick the BEST one. Respond ONLY in this JSON format (no markdown, no backticks):
{
  "winner_index": 0,
  "verdict_label": "short punchy label like 'Outfit 2 is the move'",
  "reason": "2-3 sentences explaining why the winner works best",
  "tips": ["tip about winner", "tip 2", "tip 3"]
}
 
winner_index is 0-based (Outfit 1 = 0). Be decisive.`;
    }
 
    messageContent.push({ type: 'text', text: promptText });
 
    const openrouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://pickr.app',
        'X-Title': 'Pickr'
      },
      body: JSON.stringify({
        model: 'openrouter/free',
        models: [
          'google/gemma-4-31b-it:free',
          'meta-llama/llama-3.2-90b-vision-instruct:free',
          'qwen/qwen2.5-vl-72b-instruct:free'
        ],
        messages: [
          {
            role: 'system',
            content: 'You are a warm, stylish personal stylist. Always respond ONLY in the requested JSON format — no preamble, no backticks, no markdown.'
          },
          {
            role: 'user',
            content: messageContent
          }
        ],
        max_tokens: 1000
      })
    });
 
    if (!openrouterRes.ok) {
      const errText = await openrouterRes.text();
      console.error('OpenRouter error:', errText);
      return res.status(500).json({ error: 'AI service error', details: errText });
    }
 
    const data = await openrouterRes.json();
    const rawText = data.choices?.[0]?.message?.content || '';
 
    let parsed = null;
 
    // Strategy 1: Try direct JSON parse (after stripping markdown fences)
    try {
      let cleaned = rawText.replace(/```json|```/gi, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Try next strategy
    }
 
    // Strategy 2: Extract the JSON between first { and last }
    if (!parsed || (typeof parsed === 'object' && !parsed.verdict && parsed.winner_index === undefined)) {
      try {
        let cleaned = rawText.replace(/```json|```/gi, '').trim();
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          const extracted = cleaned.substring(firstBrace, lastBrace + 1);
          parsed = JSON.parse(extracted);
        }
      } catch (e) {
        // Try next strategy
      }
    }
 
    // Strategy 3: If parsed but missing required fields, look for nested response
    if (parsed && typeof parsed === 'object' && !parsed.verdict && parsed.winner_index === undefined && !parsed.verdict_label) {
      for (const key of Object.keys(parsed)) {
        const val = parsed[key];
        if (val && typeof val === 'object' && (val.verdict || val.winner_index !== undefined || val.verdict_label)) {
          parsed = val;
          break;
        }
      }
    }
 
    // Strategy 4: Last resort - extract fields manually with regex if JSON parse failed completely
    if (!parsed || (typeof parsed === 'object' && !parsed.verdict && parsed.winner_index === undefined && !parsed.verdict_label)) {
      try {
        const verdictMatch = rawText.match(/"verdict"\s*:\s*"([^"]+)"/);
        const labelMatch = rawText.match(/"verdict_label"\s*:\s*"([^"]+)"/);
        const reasonMatch = rawText.match(/"reason"\s*:\s*"([^"]+)"/);
        const winnerMatch = rawText.match(/"winner_index"\s*:\s*(\d+)/);
        const tipsMatch = rawText.match(/"tips"\s*:\s*\[([\s\S]*?)\]/);
 
        if (labelMatch || verdictMatch || winnerMatch !== null) {
          parsed = {};
          if (verdictMatch) parsed.verdict = verdictMatch[1];
          if (labelMatch) parsed.verdict_label = labelMatch[1];
          if (reasonMatch) parsed.reason = reasonMatch[1];
          if (winnerMatch) parsed.winner_index = parseInt(winnerMatch[1], 10);
          if (tipsMatch) {
            const tipsRaw = tipsMatch[1];
            const tipMatches = [...tipsRaw.matchAll(/"([^"]+)"/g)];
            parsed.tips = tipMatches.map(m => m[1]);
          } else {
            parsed.tips = ['Style with confidence!', 'Trust your instincts.', 'Have fun with it.'];
          }
        }
      } catch (e) {
        // Give up
      }
    }
 
    // If we still can't parse, return error
    if (!parsed || typeof parsed !== 'object') {
      console.error('Parse error - raw response:', rawText);
      return res.status(500).json({
        error: 'Could not parse AI response',
        raw: rawText.substring(0, 500)
      });
    }
 
    // Ensure required fields exist with defaults
    if (mode === 'single' && !parsed.verdict) {
      parsed.verdict = 'MAYBE';
    }
    if (!parsed.verdict_label) {
      parsed.verdict_label = mode === 'single' ? 'Worth a try' : 'Outfit picked';
    }
    if (!parsed.reason) {
      parsed.reason = 'Looking great overall.';
    }
    if (!parsed.tips || !Array.isArray(parsed.tips) || parsed.tips.length === 0) {
      parsed.tips = ['Trust your instincts.', 'Confidence is the best accessory.', 'Have fun with the look.'];
    }
    if (mode === 'compare' && parsed.winner_index === undefined) {
      parsed.winner_index = 0;
    }
 
    return res.status(200).json(parsed);
 
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error', message: err.message });
  }
}
 
