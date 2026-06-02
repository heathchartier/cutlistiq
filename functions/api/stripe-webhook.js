// CutListIQ — Cloudflare Pages Function
// Handles Stripe webhook events and updates Supabase plan accordingly.
// Env vars required: STRIPE_WEBHOOK_SECRET, SUPABASE_SERVICE_ROLE_KEY,
//                    SUPABASE_URL (optional — defaults to HC Routes project)

async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = {};
  for (const part of sigHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx > -1) parts[part.slice(0, idx)] = part.slice(idx + 1);
  }
  const { t, v1 } = parts;
  if (!t || !v1) return false;

  // Reject stale events (> 5 minutes)
  if (Math.abs(Date.now() / 1000 - parseInt(t)) > 300) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${t}.${payload}`));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === v1;
}

async function updatePlan(env, userId, plan, customerId, subscriptionStatus) {
  const supabaseUrl = env.SUPABASE_URL || 'https://oaxkcsnmiozpnnhlmkmi.supabase.co';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set — cannot update plan');
    return;
  }

  const patch = async (body) => {
    const res = await fetch(`${supabaseUrl}/rest/v1/cutlistiq_profiles?id=eq.${userId}`, {
      method: 'PATCH',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Supabase update error:', err);
      return false;
    }
    return true;
  };

  // Always update plan first — this is the critical field
  await patch({ plan });

  // Update Stripe metadata columns separately so a missing column never blocks the plan update
  const meta = { subscription_status: subscriptionStatus };
  if (customerId) meta.stripe_customer_id = customerId;
  await patch(meta);
}

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new Response('Webhook secret not configured', { status: 500 });
  }

  const payload = await request.text();
  const sigHeader = request.headers.get('stripe-signature') || '';

  const valid = await verifyStripeSignature(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    console.error('Stripe webhook signature invalid');
    return new Response('Invalid signature', { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const obj = event.data?.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      // Trial has started — grant access immediately
      const userId = obj.metadata?.supabase_user_id;
      const planType = obj.metadata?.plan_type || 'pro';
      const customerId = obj.customer;
      if (!userId) break;
      const plan = planType === 'quickcut' ? 'quickcut' : 'pro';
      await updatePlan(env, userId, plan, customerId, 'trialing');
      break;
    }

    case 'customer.subscription.updated': {
      const userId = obj.metadata?.supabase_user_id;
      const customerId = obj.customer;
      if (!userId) break;
      const planType = obj.metadata?.plan_type || 'pro';
      const status = obj.status; // active | trialing | past_due | canceled | incomplete | incomplete_expired
      if (status === 'active' || status === 'trialing') {
        const plan = planType === 'quickcut' ? 'quickcut' : 'pro';
        await updatePlan(env, userId, plan, customerId, status);
      } else {
        // past_due, canceled, incomplete_expired — revoke access
        await updatePlan(env, userId, 'free', customerId, status);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const userId = obj.metadata?.supabase_user_id;
      const customerId = obj.customer;
      if (!userId) break;
      await updatePlan(env, userId, 'free', customerId, 'canceled');
      break;
    }

    // invoice.payment_failed: subscription.updated handles past_due status
    default:
      break;
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Stripe sends POST only — no OPTIONS needed for webhooks
