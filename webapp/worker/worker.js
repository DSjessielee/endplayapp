/**
 * Cloudflare Worker — Claude API proxy for image extraction only.
 * Frontend is served by Cloudflare Pages. DDS calls go directly to Render.
 *
 * Deploy: cd webapp/worker && npx wrangler deploy
 * Set secret: npx wrangler secret put ANTHROPIC_API_KEY
 */

const VISION_PROMPT = `This image shows a bridge deal with four hands in compass layout. It could be:
- A screenshot from a bridge app (BBO, FunBridge, etc.)
- A printed hand diagram on paper
- Physical playing cards laid out on a table

LAYOUT:
- NORTH = the hand at the TOP of the image
- WEST = the hand on the LEFT
- EAST = the hand on the RIGHT
- SOUTH = the hand at the BOTTOM

For physical cards: cards of the same suit are grouped together. Identify each card by its rank (A K Q J 10 9 8 7 6 5 4 3 2) and suit (spades, hearts, diamonds, clubs). Cards may overlap — look carefully at each one.

OUTPUT RULES:
- List suits in order: spades.hearts.diamonds.clubs (dots between suits)
- Convert "10" to "T"
- Read EVERY card — do not skip any. Each hand has exactly 13 cards.
- Empty suit = nothing between dots (e.g. AK..QJT9764.AKT means no hearts)
- Use only: A K Q J T 9 8 7 6 5 4 3 2

IMPORTANT: Do NOT explain your reasoning. Do NOT describe what you see. Output ONLY these 4 lines and nothing else:
N: <spades>.<hearts>.<diamonds>.<clubs>
E: <spades>.<hearts>.<diamonds>.<clubs>
S: <spades>.<hearts>.<diamonds>.<clubs>
W: <spades>.<hearts>.<diamonds>.<clubs>`;

const SINGLE_HAND_PROMPT = `This image shows a SINGLE bridge hand (13 cards for one player).
It could be from a bridge app screenshot, printed diagram, or physical cards.

STEP 1 — IDENTIFY EACH CARD:
Look at each card's CORNER INDEX (top-left corner) which shows a RANK and a SUIT SYMBOL printed together.
- Read the rank: A, K, Q, J, 10, 9, 8, 7, 6, 5, 4, 3, or 2
- Read the suit symbol right next to it on the SAME card
- Cards may be fanned/overlapping — check EVERY visible corner

STEP 2 — COUNT AND VERIFY:
Count your list. A bridge hand has exactly 13 cards. If you have more or fewer, re-examine.

STEP 3 — FORMAT OUTPUT:
On your FINAL line, group by suit (spades.hearts.diamonds.clubs), ranks high-to-low, convert 10 to T.
Empty suit = nothing between dots.

Your final line must be exactly:
HAND: <spades>.<hearts>.<diamonds>.<clubs>`;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (url.pathname === "/extract-image" && request.method === "POST") {
      return handleExtractImage(request, env);
    }

    if (url.pathname === "/create-checkout" && request.method === "POST") {
      return handleCreateCheckout(request, env);
    }

    if (url.pathname === "/verify-payment" && request.method === "POST") {
      return handleVerifyPayment(request, env);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};

async function handleExtractImage(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: ["ANTHROPIC_API_KEY not configured on worker"] }, 500);
  }

  const formData = await request.formData();
  const file = formData.get("image");
  if (!file) {
    return jsonResponse({ error: ["No image uploaded"] }, 400);
  }

  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  const ext = (file.name || "").split(".").pop().toLowerCase();
  const mediaTypes = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
  const mediaType = mediaTypes[ext] || "image/jpeg";

  const direction = formData.get("direction");
  const isSingle = direction && ['N','E','S','W'].includes(direction);
  const prompt = isSingle ? SINGLE_HAND_PROMPT : VISION_PROMPT;

  const body = JSON.stringify({
    model: isSingle ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6",
    max_tokens: isSingle ? 600 : 500,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: prompt },
      ],
    }],
  });

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body,
  });

  if (!resp.ok) {
    const err = await resp.text();
    return jsonResponse({ error: [`Claude API error: ${resp.status} ${err}`] }, 502);
  }

  const result = await resp.json();
  const text = result.content[0].text;

  if (isSingle) {
    const lines = text.trim().split("\n");
    let handLine = lines[lines.length - 1];
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].match(/HAND\s*:|[AKQJT2-9]+\.[AKQJT2-9]*\.[AKQJT2-9]*\.[AKQJT2-9]*/)) {
        handLine = lines[i];
        break;
      }
    }
    let hand = handLine.replace(/10/g, "T");
    hand = hand.replace(/^.*HAND\s*:\s*/i, "");
    hand = hand.replace(/^[NESW]\s*:\s*/, "");
    hand = hand.replace(/[^AKQJT2-9.]/g, "");
    const parts = hand.split(".");
    if (parts.length >= 4) hand = parts.slice(0, 4).join(".");
    return jsonResponse({ hands: { [direction]: hand }, method: "claude-vision" });
  }

  const hands = parseHands(text);
  if (!hands) {
    return jsonResponse({ error: ["Could not parse hands from Claude response:", text] }, 400);
  }
  return jsonResponse({ hands, method: "claude-vision" });
}

// --- Stripe Checkout ---

const STRIPE_PRICE_ID = 'price_1TmO8BB5l2QZ4Vn4QpMsM1LC';

async function handleCreateCheckout(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse({ error: ["Stripe not configured"] }, 500);
  }

  const data = await request.json();
  const userId = data.user_id;
  const userEmail = data.email;
  const returnUrl = data.return_url || 'https://funbridge.pages.dev';

  const params = new URLSearchParams({
    'mode': 'subscription',
    'line_items[0][price]': STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    'success_url': returnUrl + '?payment=success&session_id={CHECKOUT_SESSION_ID}',
    'cancel_url': returnUrl + '?payment=cancelled',
    'client_reference_id': userId,
  });
  if (userEmail) params.append('customer_email', userEmail);

  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const session = await resp.json();
  if (!resp.ok) {
    return jsonResponse({ error: [session.error?.message || 'Stripe error'] }, 400);
  }

  return jsonResponse({ url: session.url, session_id: session.id });
}

async function handleVerifyPayment(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse({ error: ["Stripe not configured"] }, 500);
  }

  const data = await request.json();
  const sessionId = data.session_id;
  if (!sessionId) {
    return jsonResponse({ error: ["Missing session_id"] }, 400);
  }

  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions/' + sessionId, {
    headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY },
  });

  const session = await resp.json();
  if (!resp.ok || session.payment_status !== 'paid') {
    return jsonResponse({ error: ["Payment not completed"], paid: false }, 400);
  }

  return jsonResponse({
    paid: true,
    user_id: session.client_reference_id,
    subscription_id: session.subscription,
    customer_email: session.customer_details?.email,
  });
}

function parseHands(text) {
  const hands = {};
  for (const line of text.trim().split("\n")) {
    const m = line.match(/([NESW])\s*:\s*(.+)/);
    if (!m) continue;
    let hand = m[2].trim().replace(/10/g, "T");
    hand = hand.replace(/[^AKQJT2-9.]/g, "");
    const parts = hand.split(".");
    if (parts.length === 4) hands[m[1]] = hand;
    else if (parts.length > 4) hands[m[1]] = parts.slice(0, 4).join(".");
  }
  if (Object.keys(hands).length >= 3) return hands;

  const dirMap = {NORTH:'N', SOUTH:'S', EAST:'E', WEST:'W'};
  for (const [full, abbr] of Object.entries(dirMap)) {
    if (hands[abbr]) continue;
    const re = new RegExp(full + '[^:]*:([\\s\\S]*?)(?=(?:NORTH|SOUTH|EAST|WEST|$))', 'i');
    const bm = text.match(re);
    if (!bm) continue;
    const block = bm[1].replace(/10/g, 'T');
    const suits = [];
    for (const suitName of ['Spades?', 'Hearts?', 'Diamonds?', 'Clubs?']) {
      const sm = block.match(new RegExp(suitName + '[:\\s,]*([AKQJT2-9,\\s]+)', 'i'));
      suits.push(sm ? sm[1].replace(/[^AKQJT2-9]/g, '') : '');
    }
    if (suits.some(s => s.length > 0)) hands[abbr] = suits.join('.');
  }
  return Object.keys(hands).length >= 3 ? hands : null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
