// CutListIQ — Cloudflare Pages Function
// Creates a Stripe Checkout session for Quick Cut Unlimited or Shop Pro subscriptions.
// Env vars required: STRIPE_SECRET_KEY, STRIPE_PRICE_PRO, STRIPE_PRICE_QUICKCUT,
//                    SUPABASE_URL (optional), SUPABASE_SERVICE_ROLE_KEY (optional)

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

  const { userId, email, planType, returnUrl } = body;
  if (!userId || !email || !planType || !returnUrl) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers });
  }

  const priceId = planType === 'quickcut' ? env.STRIPE_PRICE_QUICKCUT : env.STRIPE_PRICE_PRO;
  if (!priceId) {
    return new Response(JSON.stringify({ error: `Price not configured for plan: ${planType}` }), { status: 500, headers });
  }

  const supabaseUrl = env.SUPABASE_URL || 'https://oaxkcsnmiozpnnhlmkmi.supabase.co';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  // Look up existing Stripe customer ID from Supabase
  let stripeCustomerId = null;
  if (serviceKey) {
    try {
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
    } catch (e) {
      console.error('Supabase lookup error:', e);
    }
  }

  // Create Stripe customer if none exists
  if (!stripeCustomerId) {
    const custRes = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        email,
        'metadata[supabase_user_id]': userId,
      }).toString(),
    });
    if (!custRes.ok) {
      const err = await custRes.text();
      console.error('Stripe create customer error:', err);
      return new Response(JSON.stringify({ error: 'Failed to create customer' }), { status: 502, headers });
    }
    const customer = await custRes.json();
    stripeCustomerId = customer.id;

    // Save customer ID back to Supabase
    if (serviceKey) {
      await fetch(`${supabaseUrl}/rest/v1/cutlistiq_profiles?id=eq.${userId}`, {
        method: 'PATCH',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ stripe_customer_id: stripeCustomerId }),
      });
    }
  }

  // Create Checkout session
  const sessionParams = new URLSearchParams({
    customer: stripeCustomerId,
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'subscription_data[trial_period_days]': '7',
    'subscription_data[metadata][supabase_user_id]': userId,
    'subscription_data[metadata][plan_type]': planType,
    'metadata[supabase_user_id]': userId,
    'metadata[plan_type]': planType,
    success_url: `${returnUrl}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${returnUrl}?checkout=canceled`,
  });

  const sessionRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: sessionParams.toString(),
  });

  if (!sessionRes.ok) {
    const err = await sessionRes.text();
    console.error('Stripe checkout session error:', err);
    return new Response(JSON.stringify({ error: 'Failed to create checkout session' }), { status: 502, headers });
  }

  const session = await sessionRes.json();
  return new Response(JSON.stringify({ url: session.url }), { status: 200, headers });
}
