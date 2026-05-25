// CutListIQ — Cloudflare Pages Function
// Sends cut layout data to Claude Opus for expert analysis and suggestions.
// ANTHROPIC_API_KEY stored as Cloudflare Pages env variable — never client-side.

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

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers });
  }

  const {
    algorithm, sheetsCount, partsPlaced, unplacedCount,
    wastePct, sheets, parts, stockSizes
  } = data;

  const prompt = `You are an expert woodworking and cabinet shop consultant. A user just ran a cut list optimization and needs your analysis.

JOB SUMMARY:
- Algorithm: ${algorithm === 'guillotine' ? 'Guillotine (panel saw)' : 'Nested (best-fit)'}
- Sheets used: ${sheetsCount}
- Parts placed: ${partsPlaced}${unplacedCount > 0 ? `\n- UNPLACED PARTS: ${unplacedCount} (critical issue)` : ''}
- Overall waste: ${wastePct.toFixed(1)}%

STOCK SHEET SIZES AVAILABLE:
${stockSizes.map(s => `- ${s.w}" × ${s.h}" (${s.mat || 'unlabeled'}) — qty ${s.qty}`).join('\n')}

SHEET-BY-SHEET BREAKDOWN:
${sheets.map((s, i) => `Sheet ${i + 1}: ${s.w}" × ${s.h}" (${s.mat || 'unlabeled'}) — ${s.waste.toFixed(1)}% waste, ${s.partCount} parts`).join('\n')}

PARTS LIST:
${parts.map(p => `- ${p.label || 'Unlabeled'}: ${p.w}" × ${p.h}", qty ${p.qty}`).join('\n')}

Analyze this layout and provide 3–5 specific, actionable recommendations. Focus on:
1. Any sheets with high waste (>35%) and how to reduce it
2. Whether switching algorithms (guillotine vs nested) might help
3. Stock sheet size adjustments that would improve efficiency
4. Part rotation or grouping opportunities
5. If any parts are unplaced, why and how to fix it

Rules:
- Be specific — mention actual dimensions and part names from the data above
- Keep each recommendation to 2–3 sentences max
- Classify each as: "warning" (problem to fix), "tip" (improvement opportunity), or "success" (something working well)
- If waste is under 15% overall and all parts are placed, just give 1–2 "success" items
- Return ONLY a JSON array, no explanation, no markdown

Format:
[{"type":"warning|tip|success","title":"Short title under 6 words","body":"Specific actionable recommendation."}]`;

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
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: prompt,
        }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return new Response(JSON.stringify({ error: 'AI service error' }), { status: 502, headers });
    }

    const result = await response.json();
    const text = (result.content?.[0]?.text || '').trim();

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return new Response(JSON.stringify({ error: 'No insights returned', raw: text }), { status: 422, headers });
    }

    const insights = JSON.parse(match[0]);
    return new Response(JSON.stringify({ insights }), { status: 200, headers });

  } catch (err) {
    console.error('Function error:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers });
  }
}
