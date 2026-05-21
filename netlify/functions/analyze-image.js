// CutListIQ — Netlify serverless function
// Proxies image/PDF to Claude API for cut list extraction.
// ANTHROPIC_API_KEY is stored as a Netlify environment variable — never exposed to clients.

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Basic origin check (tighten to your domain after launch)
  const origin = event.headers.origin || '';
  const allowed = [
    'https://cutlistiq.netlify.app',
    'https://cutlistiq.com',
    'https://www.cutlistiq.com',
    'http://localhost',
    'http://127.0.0.1',
  ];
  const corsOrigin = allowed.includes(origin) ? origin : allowed[0];

  const headers = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { image, mimeType } = body;
  if (!image || !mimeType) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing image or mimeType' }) };
  }

  const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
  if (!validTypes.includes(mimeType)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unsupported file type' }) };
  }

  const prompt = `You are analyzing a cut list for sheet materials (plywood, MDF, melamine, etc.).

Extract every part/cut from this image and return ONLY a JSON array — no explanation, no markdown, just the raw JSON.

Each item in the array should have:
- "label": part name or description (string, use "Part" + number if unlabeled)
- "w": width as a number in the same units shown (inches unless otherwise noted)
- "h": length/height as a number
- "qty": quantity as a number (default 1 if not shown)
- "mat": material type if visible (string, omit if not shown)

Rules:
- Convert fractions to decimals (e.g. 23-1/2 → 23.5, 3/4 → 0.75)
- If the list shows feet, convert to inches (multiply by 12)
- Ignore header rows, totals, notes
- If you cannot find any valid cut dimensions, return []

Example output: [{"label":"Side Panel","w":23.5,"h":47.75,"qty":2,"mat":"3/4 Plywood"},{"label":"Shelf","w":22,"h":18,"qty":4}]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: image },
            },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'AI service error' }) };
    }

    const data = await response.json();
    const text = (data.content?.[0]?.text || '').trim();

    // Extract JSON array from response
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return { statusCode: 422, headers, body: JSON.stringify({ error: 'No cut list found in image', raw: text }) };
    }

    const parts = JSON.parse(match[0]);
    return { statusCode: 200, headers, body: JSON.stringify({ parts }) };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
