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

Extract the job name and every part from this image. Return ONLY a JSON object — no explanation, no markdown, just raw JSON.

Return exactly this structure:
{"jobName":"","parts":[...],"stocks":[...]}

jobName: look for a "JOB NAME:", "JOB:", or "PROJECT:" field near the top of the document. Use empty string if not found.

Each part object:
- "label": part name or description (use "Part" + number if unlabeled)
- "w": the WIDTH as written in the document (preserve the user's column — do NOT swap based on which number is smaller)
- "h": the LENGTH as written in the document (preserve the user's column — do NOT swap based on which number is larger)
- "qty": quantity as a number (default 1 if not shown)
- "mat": material type — CRITICAL: if a row's material column is blank, carry forward the last seen material value from above. Every part must have a mat value if any material appears anywhere in the list.

For stocks, generate one entry per unique material found in parts:
- "w": always 49
- "h": smallest standard height fitting that material's largest dimension: 97 (≤96"), 121 (≤120"), 145 (≤144"), 193 (≤192")
- "qty": 50
- "mat": same material string as the parts
- "label": same as mat

Rules:
- CRITICAL: Preserve the user's width/length as written. A 23½ × 6½ part must stay w:23.5, h:6.5 — never swap dimensions to make w the smaller number. The user wrote it that way intentionally.
- Convert fractions to decimals: 16-3/8 → 16.375, 31-1/4 → 31.25, 15-5/8 → 15.625, 47-1/2 → 47.5
- If the list shows feet, convert to inches (multiply by 12)
- Ignore header rows, totals, thickness notes
- If no valid dimensions found, return {"jobName":"","parts":[],"stocks":[]}

Example: {"jobName":"Kings Display","parts":[{"label":"Side Panel","w":23.5,"h":47.75,"qty":2,"mat":"WF392"},{"label":"Shelf","w":22,"h":18,"qty":4,"mat":"WF392"}],"stocks":[{"w":49,"h":97,"qty":50,"mat":"WF392","label":"WF392"}]}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            // PDFs use 'document' type; images use 'image' type
            mimeType === 'application/pdf'
              ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image } }
              : { type: 'image', source: { type: 'base64', media_type: mimeType, data: image } },
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

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return new Response(JSON.stringify({ error: 'No cut list found in image', raw: text }), { status: 422, headers });
    }

    const parsed = JSON.parse(match[0]);
    const parts = Array.isArray(parsed.parts) ? parsed.parts : [];
    const stocks = Array.isArray(parsed.stocks) ? parsed.stocks : [];
    const jobName = typeof parsed.jobName === 'string' ? parsed.jobName : '';
    return new Response(JSON.stringify({ parts, stocks, jobName }), { status: 200, headers });

  } catch (err) {
    console.error('Function error:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers });
  }
}
