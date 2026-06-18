/**
 * Cloudflare Worker — proxies image extraction requests to Claude API.
 * Deploy via: npx wrangler deploy
 * Set secret: npx wrangler secret put ANTHROPIC_API_KEY
 */

const VISION_PROMPT = `This image shows a bridge hand diagram (likely a BBO screenshot).
Extract the four hands: North, East, South, West.

For each hand, list the cards by suit in this exact order: spades, hearts, diamonds, clubs.
Use these rank abbreviations: A K Q J T 9 8 7 6 5 4 3 2 (use T for 10).
If a suit is void (no cards), leave it empty.

Respond ONLY with exactly 4 lines in this format, no other text:
N: <spades>.<hearts>.<diamonds>.<clubs>
E: <spades>.<hearts>.<diamonds>.<clubs>
S: <spades>.<hearts>.<diamonds>.<clubs>
W: <spades>.<hearts>.<diamonds>.<clubs>

Example: N: AJ7.653.AK7.KJ76`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "POST only" }, 405);
    }

    const url = new URL(request.url);

    if (url.pathname === "/extract-image") {
      return handleExtractImage(request, env);
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
  const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

  const ext = (file.name || "").split(".").pop().toLowerCase();
  const mediaTypes = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
  const mediaType = mediaTypes[ext] || "image/jpeg";

  const body = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: VISION_PROMPT },
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
  const hands = parseHands(text);

  if (!hands) {
    return jsonResponse({ error: ["Could not parse hands from Claude response"] }, 400);
  }

  return jsonResponse({ hands, method: "claude-vision" });
}

function parseHands(text) {
  const hands = {};
  for (const line of text.trim().split("\n")) {
    const m = line.match(/^\s*([NESW])\s*:\s*(.+)$/);
    if (!m) continue;
    let hand = m[2].trim().replace(/10/g, "T");
    hand = hand.replace(/[^AKQJT2-9.]/g, "");
    const parts = hand.split(".");
    if (parts.length === 4) {
      hands[m[1]] = hand;
    }
  }
  return Object.keys(hands).length >= 3 ? hands : null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
