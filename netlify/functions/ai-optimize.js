// CutListIQ — AI Optimization Function
// Sends cut layout data to Claude Opus for expert analysis and suggestions.
// ANTHROPIC_API_KEY stored as Netlify/Cloudflare env variable — never client-side.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

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

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API not configured' }) };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
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
        'x-api-key': process.env.ANTHROPIC_API_KEY,
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
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'AI service error' }) };
    }

    const result = await response.json();
    const text = (result.content?.[0]?.text || '').trim();

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return { statusCode: 422, headers, body: JSON.stringify({ error: 'No insights returned', raw: text }) };
    }

    const insights = JSON.parse(match[0]);
    return { statusCode: 200, headers, body: JSON.stringify({ insights }) };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
