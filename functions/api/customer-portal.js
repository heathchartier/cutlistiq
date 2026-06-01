// CutListIQ — Cloudflare Pages Function
// Creates a Stripe Customer Portal session so subscribers can manage billing.
// Env vars required: STRIPE_SECRET_KEY, SUPABASE_SERVICE_ROLE_KEY,
//                    SUPABASE_URL (optional)

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

  if (!env.STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), { status: 500, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers });
  }

  const { userId, returnUrl } = body;
  if (!userId || !returnUrl) {
    return new Response(JSON.stringify({ error: 'Missing userId or returnUrl' }), { status: 400, headers });
  }

  const supabaseUrl = env.SUPABASE_URL || 'https://oaxkcsnmiozpnnhlmkmi.supabase.co';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  // Look up stripe_customer_id from Supabase
  let stripeCustomerId = null;
  if (serviceKey) {
    const sbRes = await fetch(
      `${supabaseUrl}/rest/v1/cutlistiq_profiles?id=eq.${userId}&select=stripe_customer_id`,
      {
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
        },
      }
    );
    if (sbRes.ok) {
      const rows = await sbRes.json();
      stripeCustomerId = rows?.[0]?.stripe_customer_id || null;
    }
  }

  if (!stripeCustomerId) {
    return new Response(JSON.stringify({ error: 'No billing account found for this user' }), { status: 404, headers });
  }

  const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      customer: stripeCustomerId,
      return_url: returnUrl,
    }).toString(),
  });

  if (!portalRes.ok) {
    const err = await portalRes.text();
    console.error('Stripe portal error:', err);
    return new Response(JSON.stringify({ error: 'Failed to create portal session' }), { status: 502, headers });
  }

  const portal = await portalRes.json();
  return new Response(JSON.stringify({ url: portal.url }), { status: 200, headers });
}
