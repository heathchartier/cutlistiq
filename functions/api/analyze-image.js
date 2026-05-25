// CutListIQ — Cloudflare Pages Function
// Proxies image/PDF to Claude API for cut list extraction.
// ANTHROPIC_API_KEY is stored as a Cloudflare Pages env variable — never exposed to clients.

const ALLOWED_ORIGINS = [
  'https://cutlistiq.pro',
  'https://www.cutlistiq.pro',
  'https://cutlistiq.pages.dev',
  'http://localhost',
  'http://localhost:3000',
  'http://127.0.0.1',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

export async function onRequestOptions({ request }) {
  const origin = request.headers.get('origin') || '';
  return new Response('', { status: 204, headers: corsHeaders(origin) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('origin') || '';
  const headers = corsHeaders(origin);

  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'API not configured' }), { status: 500, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
  }

  const { image, mimeType } = body;
  if (!image || !mimeType) {
    return new Response(JSON.stringify({ error: 'Missing image or mimeType' }), { status: 400, headers });
  }

  const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
  if (!validTypes.includes(mimeType)) {
    return new Response(JSON.stringify({ error: 'Unsupported file type' }), { status: 400, headers });
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
        'x-api-key': env.ANTHROPIC_API_KEY,
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
      return new Response(JSON.stringify({ error: 'AI service error' }), { status: 502, headers });
    }

    const data = await response.json();
    const text = (data.content?.[0]?.text || '').trim();

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return new Response(JSON.stringify({ error: 'No cut list found in image', raw: text }), { status: 422, headers });
    }

    const parts = JSON.parse(match[0]);
    return new Response(JSON.stringify({ parts }), { status: 200, headers });

  } catch (err) {
    console.error('Function error:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers });
  }
}
