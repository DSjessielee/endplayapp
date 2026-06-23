/**
 * Cloudflare Worker — serves frontend + proxies Claude API + proxies DDS API.
 * Single Worker handles everything for funbridge.cc
 *
 * Deploy: cd webapp/worker && npx wrangler deploy
 * Set secret: npx wrangler secret put ANTHROPIC_API_KEY
 */

const DDS_API = 'https://bridge-dds-api.onrender.com';

const VISION_PROMPT = `This image shows a bridge deal with four hands in compass layout. It could be:
- A screenshot from a bridge app (BBO, FunBridge, etc.)
- A printed hand diagram on paper
- Physical playing cards laid out on a table

LAYOUT:
- NORTH = the hand at the TOP of the image
- WEST = the hand on the LEFT
- EAST = the hand on the RIGHT
- SOUTH = the hand at the BOTTOM

For physical cards: cards of the same suit are grouped together. Identify each card by its rank (A K Q J 10 9 8 7 6 5 4 3 2) and suit (spades ♠, hearts ♥, diamonds ♦, clubs ♣). Cards may overlap — look carefully at each one.

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/extract-image" && request.method === "POST") {
      return handleExtractImage(request, env);
    }

    if (url.pathname === "/analyze" && request.method === "POST") {
      return handleAnalyze(request);
    }

    if (url.pathname === "/score" && request.method === "POST") {
      return proxyToRender(request, "/score");
    }

    if (url.pathname === "/solve" && request.method === "POST") {
      return proxyToRender(request, "/solve");
    }

    if (url.pathname === "/evaluate" && request.method === "POST") {
      return proxyToRender(request, "/evaluate");
    }

    // Serve frontend for all other GET requests
    if (request.method === "GET") {
      return new Response(HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};

// --- Image extraction via Claude API ---

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

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
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
    return jsonResponse({ error: ["Could not parse hands from Claude response:", text] }, 400);
  }

  return jsonResponse({ hands, method: "claude-vision" });
}

// --- Proxy to Render ---

async function handleAnalyze(request) {
  return proxyToRender(request, "/analyze");
}

async function proxyToRender(request, path) {
  const body = await request.text();
  try {
    const resp = await fetch(DDS_API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const data = await resp.text();
    return new Response(data, {
      status: resp.status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  } catch (e) {
    return jsonResponse({ error: ["Backend is waking up — please wait 30 seconds and try again."] }, 503);
  }
}

// --- Helpers ---

function parseHands(text) {
  const hands = {};
  for (const line of text.trim().split("\n")) {
    const m = line.match(/([NESW])\s*:\s*(.+)/);
    if (!m) continue;
    let hand = m[2].trim().replace(/10/g, "T");
    hand = hand.replace(/[^AKQJT2-9.]/g, "");
    const parts = hand.split(".");
    if (parts.length === 4) {
      hands[m[1]] = hand;
    } else if (parts.length > 4) {
      hands[m[1]] = parts.slice(0, 4).join(".");
    }
  }
  if (Object.keys(hands).length >= 3) return hands;

  // Fallback: try to extract from verbose response
  // Look for patterns like "NORTH:" or "North:" followed by card descriptions
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
      if (sm) {
        suits.push(sm[1].replace(/[^AKQJT2-9]/g, ''));
      } else {
        suits.push('');
      }
    }
    if (suits.some(s => s.length > 0)) {
      hands[abbr] = suits.join('.');
    }
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

// --- Embedded Frontend HTML ---

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Bridge Double Dummy Analyzer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      font-family: -apple-system, 'SF Pro', 'Segoe UI', system-ui, sans-serif;
      background: #d6eaf8;
      color: #1a1a2e;
      min-height: 100vh;
      min-height: -webkit-fill-available;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 24px 16px;
      padding-top: env(safe-area-inset-top, 24px);
      padding-bottom: env(safe-area-inset-bottom, 24px);
    }
    h1 { font-size: 1.4rem; margin-bottom: 4px; color: #1a3a5c; }
    .subtitle { color: #556; font-size: 0.78rem; margin-bottom: 16px; }

    .main-container {
      display: flex;
      flex-direction: column;
      gap: 24px;
      align-items: center;
      max-width: 900px;
      width: 100%;
    }

    /* Compass layout */
    .compass {
      display: grid;
      grid-template-areas:
        ".     north ."
        "west  center east"
        ".     south .";
      grid-template-columns: 1fr auto 1fr;
      grid-template-rows: auto auto auto;
      gap: 6px;
      align-items: center;
      justify-items: center;
      width: 100%;
      max-width: 480px;
    }
    .hand-box.north { grid-area: north; }
    .hand-box.east  { grid-area: east; }
    .hand-box.south { grid-area: south; }
    .hand-box.west  { grid-area: west; }
    .center-box {
      grid-area: center;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .compass-rose {
      width: 60px; height: 60px;
      border: 2px solid #2a82bd;
      border-radius: 8px;
      display: grid;
      grid-template-areas: ". n ." "w . e" ". s .";
      grid-template-columns: 1fr 1fr 1fr;
      grid-template-rows: 1fr 1fr 1fr;
      font-weight: bold; font-size: 0.85rem; color: #2a82bd;
      background: #e8f4fc;
      flex-shrink: 0;
    }
    .compass-rose span { display: flex; align-items: center; justify-content: center; }
    .compass-rose .cr-n { grid-area: n; }
    .compass-rose .cr-s { grid-area: s; }
    .compass-rose .cr-e { grid-area: e; }
    .compass-rose .cr-w { grid-area: w; }

    /* Hand box with suit rows */
    .hand-box {
      background: #fff;
      border: 2px solid #85b8d0;
      border-radius: 8px;
      padding: 8px 10px;
      width: 100%;
      max-width: 170px;
      min-width: 110px;
    }
    .hand-box.auto-filled { border-color: #47b; }
    .hand-title {
      text-align: center;
      font-weight: 600;
      font-size: 0.82rem;
      color: #2a6496;
      margin-bottom: 5px;
    }
    .suit-row {
      display: flex;
      align-items: center;
      margin-bottom: 3px;
    }
    .suit-row:last-child { margin-bottom: 0; }
    .suit-symbol {
      width: 20px;
      font-size: 1.1rem;
      text-align: center;
      flex-shrink: 0;
    }
    .suit-symbol.spade   { color: #111; }
    .suit-symbol.heart   { color: #d22; }
    .suit-symbol.diamond { color: #d22; }
    .suit-symbol.club    { color: #111; }
    .suit-input {
      flex: 1;
      min-width: 0;
      padding: 6px 6px;
      border: 1px solid #a0c4d8;
      border-radius: 4px;
      background: #f0f7fb;
      color: #1a1a2e;
      font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
      font-size: 0.88rem;
      outline: none;
      text-transform: uppercase;
      -webkit-appearance: none;
      appearance: none;
    }
    .suit-input:focus { border-color: #2a82bd; background: #e8f4fc; }
    .suit-input.error { border-color: #e55; }
    .suit-input.auto-filled { color: #2a6496; border-color: #47b; }

    /* Controls */
    .controls {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 12px;
      align-items: center;
      width: 100%;
      max-width: 480px;
    }
    .btn-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: center;
      width: 100%;
    }
    button {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, transform 0.1s;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    button:active { transform: scale(0.95); }
    .btn-analyze { background: #3498db; color: #1a1a2e; flex: 1; min-width: 100px; }
    .btn-analyze:hover { background: #2980b9; }
    .btn-analyze:disabled { background: #555; cursor: not-allowed; }
    .btn-clear { background: #8899aa; color: #1a1a2e; }
    .btn-clear:hover { background: #778899; }
    .btn-upload { background: #3498db; color: #1a1a2e; font-size: 0.84rem; }
    .btn-upload:hover { background: #2980b9; }
    .btn-swap { background: #c9a96e; color: #1a1a2e; font-size: 0.75rem; padding: 7px 10px; }
    .btn-swap:hover { background: #b8944a; }
    .swap-row { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
    #imageInput { display: none; }

    .auto-status {
      font-size: 0.75rem;
      color: #1a5276;
      min-height: 1em;
      text-align: center;
    }

    /* Results */
    .results-panel {
      width: 100%;
      max-width: 480px;
    }
    .results-title { font-size: 1.05rem; font-weight: 600; margin-bottom: 10px; color: #2a6496; }
    .result-list { list-style: none; }
    .result-item {
      padding: 10px 14px;
      margin-bottom: 7px;
      background: #fff;
      border-radius: 8px;
      border-left: 4px solid #2a82bd;
      font-size: 0.9rem;
      line-height: 1.5;
    }
    .result-item .strain { font-weight: 700; font-size: 1rem; }
    .result-item .strain.red { color: #f66; }
    .result-item .strain.black { color: #1a1a2e; }
    .result-item .strain.nt { color: #1a5276; }
    .result-item .tricks { color: #556; font-size: 0.82rem; margin-top: 2px; }
    .par-result {
      margin-top: 10px;
      padding: 10px 14px;
      background: #fff;
      border-radius: 8px;
      border-left: 4px solid #f90;
      font-size: 0.9rem;
      line-height: 1.5;
    }
    .par-result .par-label { color: #fa0; font-weight: 700; }
    .par-result .par-score { color: #1a1a2e; font-weight: 700; font-size: 1.05rem; }
    .par-result .par-contracts { color: #556; font-size: 0.82rem; margin-top: 2px; }
    .tabs { display: flex; gap: 0; margin-bottom: 16px; }
    .tab { padding: 10px 24px; background: #fff; color: #2a6496; border: 2px solid #85b8d0; border-bottom: none; border-radius: 8px 8px 0 0; cursor: pointer; font-weight: 600; font-size: 0.9rem; -webkit-tap-highlight-color: transparent; }
    .tab.active { background: #d6eaf8; color: #1a3a5c; border-color: #2a82bd; font-weight: 700; }
    .tab-content { display: none; width: 100%; }
    .tab-content.active { display: flex; flex-direction: column; align-items: center; }
    .score-form { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 360px; }
    .score-row { display: flex; align-items: center; gap: 10px; }
    .score-row label { width: 90px; font-size: 0.85rem; color: #2a6496; flex-shrink: 0; }
    .score-select, .score-num { padding: 8px 10px; border: 1px solid #a0c4d8; border-radius: 6px; background: #f0f7fb; color: #1a1a2e; font-size: 0.9rem; outline: none; -webkit-appearance: none; appearance: none; }
    .score-select { flex: 1; }
    .score-num { width: 70px; text-align: center; }
    .score-result { margin-top: 16px; padding: 16px; background: #fff; border-radius: 8px; border-left: 4px solid #2a82bd; text-align: center; }
    .score-points { font-size: 2rem; font-weight: 700; }
    .score-points.positive { color: #1a8040; }
    .score-points.negative { color: #c0392b; }
    .score-contract { font-size: 0.85rem; color: #667; margin-top: 4px; }
    .setting-row {
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
    }
    .setting-row label {
      font-size: 0.82rem;
      color: #667;
    }
    .setting-row select {
      padding: 6px 8px;
      border: 1px solid #a0c4d8;
      border-radius: 4px;
      background: #f0f7fb;
      color: #1a1a2e;
      font-size: 0.84rem;
      outline: none;
      -webkit-appearance: none;
      appearance: none;
    }
    .setting-row select:focus { border-color: #6f8; }
    .error-msg {
      color: #f88;
      background: #fde8e8;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 0.82rem;
      margin-top: 8px;
      width: 100%;
      max-width: 480px;
    }
    /* Evaluate tab */
    .eval-container { width: 100%; max-width: 500px; }
    .eval-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    @media (max-width: 390px) { .eval-grid { grid-template-columns: 1fr; } }
    .eval-card { background: #fff; border: 2px solid #85b8d0; border-radius: 8px; padding: 10px 12px; }
    .eval-card .hand-title { text-align: center; font-weight: 600; font-size: 0.9rem; color: #2a6496; margin-bottom: 8px; }
    .eval-row { display: flex; justify-content: space-between; font-size: 0.82rem; padding: 3px 0; border-bottom: 1px solid #d6eaf8; }
    .eval-row:last-child { border-bottom: none; }
    .eval-label { color: #667; }
    .eval-value { color: #1a1a2e; font-weight: 600; }
    .eval-desc { text-align: center; font-size: 0.78rem; color: #1a5276; margin-top: 6px; font-style: italic; }
    /* Play tab */
    .play-container { width: 100%; max-width: 500px; }
    .play-setup { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-bottom: 12px; align-items: center; }
    .play-setup select { padding: 6px 8px; border: 1px solid #a0c4d8; border-radius: 4px; background: #f0f7fb; color: #1a1a2e; font-size: 0.85rem; -webkit-appearance: none; }
    .play-setup button { padding: 8px 16px; }
    .play-board { display: grid; grid-template-areas: ". north ." "west trick east" ". south ."; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center; justify-items: center; }
    .play-hand { background: #fff; border: 2px solid #85b8d0; border-radius: 8px; padding: 6px 8px; min-width: 100px; max-width: 160px; width: 100%; }
    .play-hand.active-player { border-color: #e67e22; }
    .play-hand.north { grid-area: north; } .play-hand.south { grid-area: south; }
    .play-hand.west { grid-area: west; } .play-hand.east { grid-area: east; }
    .play-hand .hand-title { text-align: center; font-weight: 600; font-size: 0.78rem; color: #2a6496; margin-bottom: 4px; }
    .play-suit { display: flex; flex-wrap: wrap; gap: 2px; margin-bottom: 2px; align-items: center; }
    .play-suit .suit-sym { font-size: 0.9rem; width: 16px; text-align: center; flex-shrink: 0; }
    .play-suit .suit-sym.spade { color: #111; } .play-suit .suit-sym.heart { color: #d22; }
    .play-suit .suit-sym.diamond { color: #d22; } .play-suit .suit-sym.club { color: #111; }
    .play-card { position: relative; padding: 3px 5px 10px 5px; border: 1px solid #a0c4d8; border-radius: 3px; background: #f0f7fb; color: #556; font-family: 'SF Mono','Consolas',monospace; font-size: 0.8rem; cursor: default; user-select: none; -webkit-tap-highlight-color: transparent; min-width: 22px; text-align: center; }
    .play-card.playable { cursor: pointer; color: #1a1a2e; background: #e0f0fa; border-color: #2a82bd; }
    .play-card.playable:hover { background: #c8e4f8; }
    .play-card.best { color: #1a8040; font-weight: 700; }
    .play-card .dd-hint { position: absolute; bottom: 1px; right: 2px; font-size: 0.55rem; line-height: 1; }
    .trick-area { grid-area: trick; width: 100px; height: 100px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #fff; border: 2px solid #85b8d0; border-radius: 8px; }
    .trick-cards { display: grid; grid-template-areas: ". n ." "w . e" ". s ."; grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1fr 1fr 1fr; width: 90px; height: 70px; font-size: 0.8rem; }
    .trick-cards span { display: flex; align-items: center; justify-content: center; }
    .trick-cards .tc-n { grid-area: n; } .trick-cards .tc-s { grid-area: s; }
    .trick-cards .tc-e { grid-area: e; } .trick-cards .tc-w { grid-area: w; }
    .play-info { display: flex; justify-content: center; gap: 20px; margin-top: 10px; font-size: 0.9rem; }
    .play-info .tricks-ns { color: #1a8040; } .play-info .tricks-ew { color: #c0392b; }
    .play-btns { display: flex; gap: 8px; justify-content: center; margin-top: 10px; }
    .btn-undo { background: #c9a96e; color: #1a1a2e; font-size: 0.82rem; padding: 8px 16px; }
    .btn-undo:hover { background: #b8944a; }
    /* Crop modal */
    .crop-overlay {
      display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.85); z-index: 1000;
      flex-direction: column; align-items: center; justify-content: center; padding: 16px;
    }
    .crop-overlay.active { display: flex; }
    .crop-title { color: #fff; font-size: 0.9rem; margin-bottom: 8px; }
    .crop-canvas-wrap {
      position: relative; max-width: 90vw; max-height: 60vh; overflow: hidden;
      border: 2px solid #4a8; border-radius: 8px; cursor: crosshair;
    }
    .crop-canvas-wrap canvas { display: block; max-width: 100%; max-height: 60vh; }
    .crop-btns { display: flex; gap: 10px; margin-top: 12px; }
    .crop-btns button { padding: 10px 20px; border-radius: 8px; font-size: 0.9rem; font-weight: 600; border: none; cursor: pointer; }
    .btn-crop-use { background: #3498db; color: #fff; }
    .btn-crop-full { background: #6a8; color: #fff; }
    .btn-crop-cancel { background: #888; color: #fff; }

    .spinner {
      display: none;
      margin: 8px auto;
      width: 24px; height: 24px;
      border: 3px solid #a0c4d8;
      border-top: 3px solid #2a82bd;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ---- Tablet (iPad) ---- */
    @media (min-width: 700px) {
      .main-container {
        flex-direction: row;
        flex-wrap: wrap;
        justify-content: center;
        align-items: flex-start;
        gap: 32px;
      }
      .compass {
        max-width: 480px;
        grid-template-columns: 170px auto 170px;
      }
      .hand-box { max-width: 170px; }
      .results-panel { max-width: 360px; }
    }

    /* ---- Small phone (iPhone SE, mini) ---- */
    @media (max-width: 390px) {
      body { padding: 16px 10px; }
      h1 { font-size: 1.2rem; }
      .compass { gap: 4px; }
      .hand-box {
        padding: 6px 6px;
        min-width: 95px;
        max-width: 140px;
      }
      .hand-title { font-size: 0.75rem; margin-bottom: 3px; }
      .suit-symbol { width: 16px; font-size: 0.95rem; }
      .suit-input { padding: 5px 4px; font-size: 0.82rem; }
      .compass-rose { width: 48px; height: 48px; font-size: 0.75rem; }
      button { padding: 10px 14px; font-size: 0.84rem; }
      .result-item { padding: 8px 10px; font-size: 0.84rem; }
    }

    /* ---- Medium phone (iPhone 14/15/16) ---- */
    @media (min-width: 391px) and (max-width: 699px) {
      .compass {
        grid-template-columns: 1fr auto 1fr;
      }
      .hand-box { max-width: 160px; }
      .compass-rose { width: 56px; height: 56px; }
    }
  </style>
</head>
<body>
  <h1>Bridge Double Dummy Analyzer</h1>
  <p class="subtitle">Enter cards by suit, or upload a screenshot</p>
  <div class="tabs">
    <div class="tab active" onclick="switchTab('dds')">DD Analyzer</div>
    <div class="tab" onclick="switchTab('play')">Play</div>
    <div class="tab" onclick="switchTab('eval')">Evaluate</div>
    <div class="tab" onclick="switchTab('score')">Scoring</div>
  </div>
  <div class="main-container">
    <div id="tab-dds" class="tab-content active" style="display:flex; flex-direction:column; align-items:center;">
      <div class="compass">
        <div class="hand-box north" id="box-north">
          <div class="hand-title">North</div>
          <div class="suit-row"><span class="suit-symbol spade">♠</span><input class="suit-input" data-dir="N" data-suit="0" placeholder="AKQ" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol heart">♥</span><input class="suit-input" data-dir="N" data-suit="1" placeholder="JT9" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol diamond">♦</span><input class="suit-input" data-dir="N" data-suit="2" placeholder="876" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol club">♣</span><input class="suit-input" data-dir="N" data-suit="3" placeholder="5432" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
        </div>

        <div class="hand-box west" id="box-west">
          <div class="hand-title">West</div>
          <div class="suit-row"><span class="suit-symbol spade">♠</span><input class="suit-input" data-dir="W" data-suit="0" placeholder="" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol heart">♥</span><input class="suit-input" data-dir="W" data-suit="1" placeholder="" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol diamond">♦</span><input class="suit-input" data-dir="W" data-suit="2" placeholder="" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol club">♣</span><input class="suit-input" data-dir="W" data-suit="3" placeholder="" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
        </div>

        <div class="center-box">
          <div class="compass-rose">
            <span class="cr-n">N</span>
            <span class="cr-w">W</span>
            <span class="cr-e">E</span>
            <span class="cr-s">S</span>
          </div>
        </div>

        <div class="hand-box east" id="box-east">
          <div class="hand-title">East</div>
          <div class="suit-row"><span class="suit-symbol spade">♠</span><input class="suit-input" data-dir="E" data-suit="0" placeholder="" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol heart">♥</span><input class="suit-input" data-dir="E" data-suit="1" placeholder="" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol diamond">♦</span><input class="suit-input" data-dir="E" data-suit="2" placeholder="" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol club">♣</span><input class="suit-input" data-dir="E" data-suit="3" placeholder="" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
        </div>

        <div class="hand-box south" id="box-south">
          <div class="hand-title">South</div>
          <div class="suit-row"><span class="suit-symbol spade">♠</span><input class="suit-input" data-dir="S" data-suit="0" placeholder="" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol heart">♥</span><input class="suit-input" data-dir="S" data-suit="1" placeholder="" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol diamond">♦</span><input class="suit-input" data-dir="S" data-suit="2" placeholder="" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol club">♣</span><input class="suit-input" data-dir="S" data-suit="3" placeholder="" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
        </div>
      </div>

      <div class="controls">
        <div class="setting-row">
          <label>Vul:
            <select id="vulSelect">
              <option value="none">None</option>
              <option value="ns">N/S</option>
              <option value="ew">E/W</option>
              <option value="both">Both</option>
            </select>
          </label>
          <label>Dealer:
            <select id="dealerSelect">
              <option value="N">North</option>
              <option value="E">East</option>
              <option value="S">South</option>
              <option value="W">West</option>
            </select>
          </label>
        </div>
        <div class="btn-row">
          <button class="btn-analyze" id="analyzeBtn" onclick="analyze()">Analyze</button>
          <button class="btn-clear" onclick="clearAll()">Clear</button>
          <button class="btn-upload" onclick="document.getElementById('imageInput').click()">Load Image</button>
          <input type="file" id="imageInput" accept="image/*" onchange="uploadImage(this)" />
        </div>
        <div class="swap-row">
          <button class="btn-swap" onclick="swapHands('N','S')">N&#8596;S</button>
          <button class="btn-swap" onclick="swapHands('N','E')">N&#8596;E</button>
          <button class="btn-swap" onclick="swapHands('N','W')">N&#8596;W</button>
          <button class="btn-swap" onclick="swapHands('E','W')">E&#8596;W</button>
          <button class="btn-swap" onclick="swapHands('E','S')">E&#8596;S</button>
          <button class="btn-swap" onclick="swapHands('S','W')">S&#8596;W</button>
        </div>
        <div class="spinner" id="spinner"></div>
        <div class="auto-status" id="autoStatus"></div>
      </div>
      <div class="results-panel" id="resultsPanel" style="display:none;">
        <div class="results-title">Double Dummy Results</div>
        <ul class="result-list" id="resultList"></ul>
        <div class="par-result" id="parResult" style="display:none;"></div>
      </div>
    </div>
  </div>
  <div id="tab-play" class="tab-content">
    <div class="play-container">
      <div class="play-setup">
        <label>Contract: <select id="play-level">
          <option>1</option><option>2</option><option>3</option><option selected>4</option><option>5</option><option>6</option><option>7</option>
        </select>
        <select id="play-trump">
          <option value="C">♣</option><option value="D">♦</option><option value="H">♥</option><option value="S" selected>♠</option><option value="NT">NT</option>
        </select></label>
        <label>Declarer: <select id="play-declarer">
          <option value="N">North</option><option value="E">East</option><option value="S" selected>South</option><option value="W">West</option>
        </select></label>
        <button class="btn-analyze" onclick="startPlay()">Start Play</button>
      </div>
      <div id="playBoard" style="display:none;">
        <div class="play-board">
          <div class="play-hand north" id="ph-N"><div class="hand-title">North</div><div id="ph-cards-N"></div></div>
          <div class="play-hand west" id="ph-W"><div class="hand-title">West</div><div id="ph-cards-W"></div></div>
          <div class="trick-area"><div class="trick-cards">
            <span class="tc-n" id="tc-N"></span><span class="tc-w" id="tc-W"></span>
            <span class="tc-e" id="tc-E"></span><span class="tc-s" id="tc-S"></span>
          </div></div>
          <div class="play-hand east" id="ph-E"><div class="hand-title">East</div><div id="ph-cards-E"></div></div>
          <div class="play-hand south" id="ph-S"><div class="hand-title">South</div><div id="ph-cards-S"></div></div>
        </div>
        <div class="play-info">
          <span class="tricks-ns">N/S: <strong id="play-ns">0</strong></span>
          <span class="tricks-ew">E/W: <strong id="play-ew">0</strong></span>
          <span id="play-status" style="color:#1a5276;"></span>
        </div>
        <div class="play-btns">
          <button class="btn-undo" onclick="undoPlay()">Undo</button>
          <button class="btn-clear" onclick="resetPlay()">Reset</button>
        </div>
      </div>
    </div>
  </div>
  <div id="tab-eval" class="tab-content">
    <div class="eval-container">
      <button class="btn-analyze" onclick="evaluateHands()" style="margin-bottom:12px;">Evaluate Hands</button>
      <div id="evalGrid" class="eval-grid"></div>
    </div>
  </div>
  <div id="tab-score" class="tab-content">
    <div class="score-form">
      <div class="score-row">
        <label>Level</label>
        <select class="score-select" id="sc-level">
          <option>1</option><option>2</option><option>3</option><option selected>4</option><option>5</option><option>6</option><option>7</option>
        </select>
      </div>
      <div class="score-row">
        <label>Suit</label>
        <select class="score-select" id="sc-suit">
          <option value="C">&#9827; Clubs</option><option value="D">&#9830; Diamonds</option><option value="H">&#9829; Hearts</option><option value="S">&#9824; Spades</option><option value="NT" selected>NT</option>
        </select>
      </div>
      <div class="score-row">
        <label>Declarer</label>
        <select class="score-select" id="sc-declarer">
          <option value="N">North</option><option value="E">East</option><option value="S" selected>South</option><option value="W">West</option>
        </select>
      </div>
      <div class="score-row">
        <label>Vulnerability</label>
        <select class="score-select" id="sc-vul">
          <option value="none">None</option><option value="ns">N/S</option><option value="ew">E/W</option><option value="both">Both</option>
        </select>
      </div>
      <div class="score-row">
        <label>Doubled</label>
        <select class="score-select" id="sc-penalty">
          <option value="">Undoubled</option><option value="X">Doubled</option><option value="XX">Redoubled</option>
        </select>
      </div>
      <div class="score-row">
        <label>Result</label>
        <select class="score-select" id="sc-result">
          <option value="-13">-13</option><option value="-12">-12</option><option value="-11">-11</option><option value="-10">-10</option>
          <option value="-9">-9</option><option value="-8">-8</option><option value="-7">-7</option><option value="-6">-6</option>
          <option value="-5">-5</option><option value="-4">-4</option><option value="-3">-3</option><option value="-2">-2</option>
          <option value="-1">-1</option><option value="0" selected>= (just made)</option>
          <option value="1">+1</option><option value="2">+2</option><option value="3">+3</option><option value="4">+4</option>
          <option value="5">+5</option><option value="6">+6</option>
        </select>
      </div>
      <button class="btn-analyze" onclick="calcScore()">Calculate Score</button>
      <div class="score-result" id="scoreResult" style="display:none;">
        <div class="score-points" id="scorePoints"></div>
        <div class="score-contract" id="scoreContract"></div>
      </div>
    </div>
  </div>
  </div>

  <div class="crop-overlay" id="cropOverlay">
    <div class="crop-title">Drag to crop the hand diagram, or use full image</div>
    <div class="crop-canvas-wrap">
      <canvas id="cropCanvas"></canvas>
    </div>
    <div class="crop-btns">
      <button class="btn-crop-use" id="cropUseBtn" disabled>Use Crop</button>
      <button class="btn-crop-full" id="cropFullBtn">Use Full Image</button>
      <button class="btn-crop-cancel" id="cropCancelBtn">Cancel</button>
    </div>
  </div>
  <div id="errorBox" class="error-msg" style="display:none;"></div>

  <script>
    const TABS = ['dds', 'play', 'eval', 'score'];
    function switchTab(tab) {
      document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', TABS[i] === tab));
      TABS.forEach(t => {
        const el = document.getElementById('tab-' + t);
        if (el) { el.style.display = t === tab ? 'flex' : 'none'; el.classList.toggle('active', t === tab); }
      });
    }

    async function calcScore() {
      const data = {
        level: parseInt(document.getElementById('sc-level').value),
        suit: document.getElementById('sc-suit').value,
        declarer: document.getElementById('sc-declarer').value,
        vulnerability: document.getElementById('sc-vul').value,
        penalty: document.getElementById('sc-penalty').value,
        result: parseInt(document.getElementById('sc-result').value),
      };
      try {
        const resp = await fetch('/score', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) });
        const res = await resp.json();
        if (!resp.ok) { showError(res.error || ['Score calculation failed']); return; }
        showError(null);
        const el = document.getElementById('scoreResult');
        el.style.display = 'block';
        const pts = document.getElementById('scorePoints');
        pts.textContent = (res.score >= 0 ? '+' : '') + res.score;
        pts.className = 'score-points ' + (res.score >= 0 ? 'positive' : 'negative');
        document.getElementById('scoreContract').textContent = res.contract;
      } catch (err) { showError([err.message]); }
    }

    const ALL_RANKS = 'AKQJT98765432';
    const DIRS = ['N', 'E', 'S', 'W'];
    const DIR_NAMES = {N: 'North', E: 'East', S: 'South', W: 'West'};

    function getInputs(dir) {
      return [0,1,2,3].map(s =>
        document.querySelector(\`.suit-input[data-dir="\${dir}"][data-suit="\${s}"]\`)
      );
    }

    function getHand(dir) {
      return getInputs(dir).map(el => el.value.trim().toUpperCase());
    }

    function setHand(dir, suits) {
      const inputs = getInputs(dir);
      suits.forEach((s, i) => {
        inputs[i].value = s;
        inputs[i].classList.add('auto-filled');
      });
      document.getElementById('box-' + DIR_NAMES[dir].toLowerCase()).classList.add('auto-filled');
    }

    function handCardCount(dir) {
      return getHand(dir).join('').length;
    }

    function isHandComplete(dir) {
      return handCardCount(dir) === 13;
    }

    function tryAutoPopulate() {
      document.querySelectorAll('.suit-input.auto-filled').forEach(el => el.classList.remove('auto-filled'));
      document.querySelectorAll('.hand-box.auto-filled').forEach(el => el.classList.remove('auto-filled'));
      const status = document.getElementById('autoStatus');
      status.textContent = '';

      const complete = DIRS.filter(d => isHandComplete(d));
      const incomplete = DIRS.filter(d => !isHandComplete(d));

      if (complete.length < 3 || incomplete.length !== 1) return;

      const emptyDir = incomplete[0];
      if (handCardCount(emptyDir) > 0) return;

      const remaining = [0,1,2,3].map(suit => {
        const allOfSuit = new Set(ALL_RANKS.split(''));
        complete.forEach(dir => {
          const cards = getHand(dir)[suit].toUpperCase();
          for (const c of cards) allOfSuit.delete(c);
        });
        return Array.from(allOfSuit).sort((a,b) =>
          ALL_RANKS.indexOf(a) - ALL_RANKS.indexOf(b)
        ).join('');
      });

      const total = remaining.reduce((s, r) => s + r.length, 0);
      if (total !== 13) return;

      setHand(emptyDir, remaining);
      status.textContent = \`\${DIR_NAMES[emptyDir]} auto-filled with remaining cards\`;
    }

    function swapHands(a, b) {
      const handA = getHand(a);
      const handB = getHand(b);
      const inputsA = getInputs(a);
      const inputsB = getInputs(b);
      handA.forEach((v, i) => { inputsB[i].value = v; });
      handB.forEach((v, i) => { inputsA[i].value = v; });
    }

    function showSpinner(on) {
      document.getElementById('spinner').style.display = on ? 'block' : 'none';
      document.getElementById('analyzeBtn').disabled = on;
    }

    function showError(msgs) {
      const box = document.getElementById('errorBox');
      if (!msgs || msgs.length === 0) { box.style.display = 'none'; return; }
      box.innerHTML = msgs.map(m => '&bull; ' + m).join('<br>');
      box.style.display = 'block';
    }

    function clearAll() {
      document.querySelectorAll('.suit-input').forEach(el => {
        el.value = '';
        el.classList.remove('error', 'auto-filled');
      });
      document.querySelectorAll('.hand-box').forEach(el => el.classList.remove('auto-filled'));
      document.getElementById('resultsPanel').style.display = 'none';
      document.getElementById('parResult').style.display = 'none';
      document.getElementById('autoStatus').textContent = '';
      showError(null);
    }

    function buildPbnHand(dir) {
      return getHand(dir).join('.');
    }

    async function analyze() {
      showError(null);
      document.getElementById('resultsPanel').style.display = 'none';
      document.querySelectorAll('.suit-input').forEach(el => el.classList.remove('error'));

      const hands = {};
      let hasError = false;
      DIRS.forEach(dir => {
        const h = buildPbnHand(dir);
        hands[dir] = h;
        if (h.replace(/\\./g, '').length !== 13) {
          getInputs(dir).forEach(el => el.classList.add('error'));
          hasError = true;
        }
      });

      if (hasError) {
        showError(['Each hand must have exactly 13 cards.']);
        return;
      }

      showSpinner(true);
      try {
        const payload = Object.assign({}, hands, {
          vul: document.getElementById('vulSelect').value,
          dealer: document.getElementById('dealerSelect').value,
        });
        const resp = await fetch('/analyze', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload),
        });
        const data = await resp.json();

        if (!resp.ok) {
          showError(data.error || ['Analysis failed']);
          showSpinner(false);
          return;
        }

        const list = document.getElementById('resultList');
        list.innerHTML = '';
        const colorMap = {'♣': 'black', '♦': 'red', '♥': 'red', '♠': 'black', 'NT': 'nt'};

        data.results.forEach(r => {
          const li = document.createElement('li');
          li.className = 'result-item';
          li.innerHTML = \`
            <div><span class="strain \${colorMap[r.symbol] || 'black'}">\${r.symbol} \${r.name}</span></div>
            <div class="tricks">
              N/S: <strong>\${r.ns} trick\${r.ns !== 1 ? 's' : ''}</strong> &nbsp;|&nbsp;
              E/W: <strong>\${r.ew} trick\${r.ew !== 1 ? 's' : ''}</strong>
            </div>
            <div class="tricks">N: \${r.north} &nbsp; E: \${r.east} &nbsp; S: \${r.south} &nbsp; W: \${r.west}</div>
          \`;
          list.appendChild(li);
        });

        const parDiv = document.getElementById('parResult');
        if (data.par && data.par.score !== null) {
          const sign = data.par.score >= 0 ? '+' : '';
          const contracts = data.par.contracts.length > 0
            ? data.par.contracts.join(', ') : '—';
          parDiv.innerHTML = \`
            <div><span class="par-label">Par</span> &nbsp;
              <span class="par-score">N/S \${sign}\${data.par.score}</span></div>
            <div class="par-contracts">\${contracts}</div>
          \`;
          parDiv.style.display = 'block';
        } else {
          parDiv.style.display = 'none';
        }

        document.getElementById('resultsPanel').style.display = 'block';
        document.getElementById('resultsPanel').scrollIntoView({ behavior: 'smooth' });

        // Auto-populate Play tab from par contract (e.g. "3NTW+1", "4SN=")
        if (data.par && data.par.contracts && data.par.contracts.length > 0) {
          const parStr = data.par.contracts[0];
          const pm = parStr.match(/^(\\d)(NT|S|H|D|C)([NESW])/);
          if (pm) {
            document.getElementById('play-level').value = pm[1];
            document.getElementById('play-trump').value = pm[2];
            document.getElementById('play-declarer').value = pm[3];
          }
        }

        // Auto-run evaluate
        evaluateHands();

      } catch (err) {
        showError([err.message]);
      }
      showSpinner(false);
    }

    // ---- CROP LOGIC ----
    var cropImg = null;
    var cropRect = null;
    var cropDragging = false;
    var cropStart = null;
    var cropScale = 1;

    function openCropModal(file) {
      var overlay = document.getElementById('cropOverlay');
      var canvas = document.getElementById('cropCanvas');
      var ctx = canvas.getContext('2d');
      cropRect = null;
      document.getElementById('cropUseBtn').disabled = true;

      var img = new Image();
      img.onload = function() {
        cropImg = img;
        var maxW = Math.min(window.innerWidth * 0.88, 800);
        var maxH = window.innerHeight * 0.58;
        cropScale = Math.min(maxW / img.width, maxH / img.height, 1);
        canvas.width = Math.round(img.width * cropScale);
        canvas.height = Math.round(img.height * cropScale);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        overlay.classList.add('active');
      };
      img.src = URL.createObjectURL(file);
    }

    function drawCrop() {
      var canvas = document.getElementById('cropCanvas');
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(cropImg, 0, 0, canvas.width, canvas.height);
      if (cropRect) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.clearRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
        ctx.drawImage(cropImg,
          cropRect.x / cropScale, cropRect.y / cropScale,
          cropRect.w / cropScale, cropRect.h / cropScale,
          cropRect.x, cropRect.y, cropRect.w, cropRect.h);
        ctx.strokeStyle = '#4a8';
        ctx.lineWidth = 2;
        ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      }
    }

    function getCanvasPos(e, canvas) {
      var rect = canvas.getBoundingClientRect();
      var t = e.touches ? e.touches[0] : e;
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    }

    (function() {
      var canvas = document.getElementById('cropCanvas');
      function onStart(e) {
        e.preventDefault();
        cropDragging = true;
        cropStart = getCanvasPos(e, canvas);
        cropRect = null;
      }
      function onMove(e) {
        if (!cropDragging || !cropStart) return;
        e.preventDefault();
        var pos = getCanvasPos(e, canvas);
        var x = Math.min(cropStart.x, pos.x);
        var y = Math.min(cropStart.y, pos.y);
        var w = Math.abs(pos.x - cropStart.x);
        var h = Math.abs(pos.y - cropStart.y);
        cropRect = { x: x, y: y, w: w, h: h };
        document.getElementById('cropUseBtn').disabled = (w < 10 || h < 10);
        drawCrop();
      }
      function onEnd() {
        cropDragging = false;
      }
      canvas.addEventListener('mousedown', onStart);
      canvas.addEventListener('mousemove', onMove);
      canvas.addEventListener('mouseup', onEnd);
      canvas.addEventListener('touchstart', onStart, { passive: false });
      canvas.addEventListener('touchmove', onMove, { passive: false });
      canvas.addEventListener('touchend', onEnd);
    })();

    function closeCropModal() {
      document.getElementById('cropOverlay').classList.remove('active');
      cropImg = null; cropRect = null;
      document.getElementById('imageInput').value = '';
    }

    document.getElementById('cropCancelBtn').addEventListener('click', closeCropModal);

    function getCroppedBlob() {
      return new Promise(function(resolve) {
        if (!cropImg) { resolve(null); return; }
        var c = document.createElement('canvas');
        var sx, sy, sw, sh;
        if (cropRect && cropRect.w > 10 && cropRect.h > 10) {
          sx = cropRect.x / cropScale; sy = cropRect.y / cropScale;
          sw = cropRect.w / cropScale; sh = cropRect.h / cropScale;
        } else {
          sx = 0; sy = 0; sw = cropImg.width; sh = cropImg.height;
        }
        var maxW = 1200;
        var scale = Math.min(maxW / sw, 1);
        c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
        c.getContext('2d').drawImage(cropImg, sx, sy, sw, sh, 0, 0, c.width, c.height);
        c.toBlob(function(blob) { resolve(blob); }, 'image/png');
      });
    }

    async function sendImageForExtraction(blob) {
      showError(null);
      showSpinner(true);
      document.getElementById('autoStatus').textContent = 'Extracting hands from image...';

      var formData = new FormData();
      formData.append('image', blob, 'hand.png');

      try {
        var resp = await fetch('/extract-image', { method: 'POST', body: formData });
        var data = await resp.json();

        if (!resp.ok) {
          showError(data.error || ['Image extraction failed']);
          document.getElementById('autoStatus').textContent = '';
          showSpinner(false);
          return;
        }

        if (data.hands) {
          DIRS.forEach(function(dir) {
            var hand = data.hands[dir] || '';
            var suits = hand.split('.');
            var inputs = getInputs(dir);
            suits.forEach(function(s, i) { if (inputs[i]) inputs[i].value = s; });
          });
          tryAutoPopulate();

          var statusMsg = 'Image loaded via ' + (data.method || 'OCR');
          if (data.warnings && data.warnings.length > 0) {
            statusMsg += ' — check for OCR errors';
            showError(data.warnings);
          }
          document.getElementById('autoStatus').textContent = statusMsg;
        }
      } catch (err) {
        showError([err.message]);
        document.getElementById('autoStatus').textContent = '';
      }
      showSpinner(false);
    }

    document.getElementById('cropUseBtn').addEventListener('click', async function() {
      var blob = await getCroppedBlob();
      closeCropModal();
      if (blob) await sendImageForExtraction(blob);
    });

    document.getElementById('cropFullBtn').addEventListener('click', async function() {
      cropRect = null;
      var blob = await getCroppedBlob();
      closeCropModal();
      if (blob) await sendImageForExtraction(blob);
    });

    function uploadImage(input) {
      if (!input.files || !input.files[0]) return;
      openCropModal(input.files[0]);
    }

    document.querySelectorAll('.suit-input').forEach(el => {
      el.addEventListener('input', () => {
        el.classList.remove('auto-filled');
        const dir = el.getAttribute('data-dir');
        document.getElementById('box-' + DIR_NAMES[dir].toLowerCase()).classList.remove('auto-filled');
        tryAutoPopulate();
      });
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.target.blur();
          analyze();
        }
      });
    });

    // ---- PREFILL SAMPLE HAND ----
    const SAMPLE = {N:['AQ98','85','AQT754','J'], E:['74','AKQ6','KJ9','KQ97'], S:['T6','JT743','862','543'], W:['KJ532','92','3','AT862']};
    DIRS.forEach(dir => {
      const inputs = getInputs(dir);
      SAMPLE[dir].forEach((s, i) => { inputs[i].value = s; });
    });

    // ---- EVALUATE TAB ----
    async function evaluateHands() {
      showError(null);
      const hands = {};
      DIRS.forEach(dir => { hands[dir] = buildPbnHand(dir); });
      try {
        const resp = await fetch('/evaluate', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(hands) });
        const data = await resp.json();
        if (!resp.ok) { showError(data.error || ['Evaluation failed']); return; }
        const grid = document.getElementById('evalGrid');
        grid.innerHTML = '';
        ['N','E','S','W'].forEach(dir => {
          const ev = data.evaluations[dir];
          if (!ev) return;
          const card = document.createElement('div');
          card.className = 'eval-card';
          card.innerHTML = '<div class="hand-title">' + ev.name + '</div>'
            + '<div class="eval-row"><span class="eval-label">HCP</span><span class="eval-value">' + ev.hcp + '</span></div>'
            + '<div class="eval-row"><span class="eval-label">Dist pts</span><span class="eval-value">' + ev.dist_points + '</span></div>'
            + '<div class="eval-row"><span class="eval-label">Total pts</span><span class="eval-value">' + ev.total_points + '</span></div>'
            + '<div class="eval-row"><span class="eval-label">Losers</span><span class="eval-value">' + ev.losers + '</span></div>'
            + '<div class="eval-row"><span class="eval-label">Controls</span><span class="eval-value">' + ev.controls + '</span></div>'
            + '<div class="eval-row"><span class="eval-label">Rule of N</span><span class="eval-value">' + ev.rule_of_n + '</span></div>'
            + '<div class="eval-row"><span class="eval-label">Shape</span><span class="eval-value">' + ev.shape + '</span></div>'
            + (ev.description ? '<div class="eval-desc">' + ev.description + '</div>' : '');
          grid.appendChild(card);
        });
      } catch (err) { showError([err.message]); }
    }

    // ---- PLAY TAB ----
    let playState = { pbn: '', trump: 'NT', first: 'E', plays: [], nsTricks: 0, ewTricks: 0 };
    const SUIT_SYM = {S: '♠', H: '♥', D: '♦', C: '♣'};
    const SUIT_CLASS = {S: 'spade', H: 'heart', D: 'diamond', C: 'club'};
    const SUIT_ORDER = ['S','H','D','C'];

    const LHO = {N: 'E', E: 'S', S: 'W', W: 'N'};

    function startPlay() {
      const hands = {};
      let valid = true;
      DIRS.forEach(dir => {
        const h = buildPbnHand(dir);
        if (h.replace(/\\./g, '').length !== 13) valid = false;
        hands[dir] = h;
      });
      if (!valid) { showError(['Fill all 4 hands in DD Analyzer first (13 cards each).']); return; }
      showError(null);

      playState.pbn = 'N:' + hands.N + ' ' + hands.E + ' ' + hands.S + ' ' + hands.W;
      playState.trump = document.getElementById('play-trump').value;
      playState.declarer = document.getElementById('play-declarer').value;
      playState.first = LHO[playState.declarer];
      playState.level = parseInt(document.getElementById('play-level').value);
      playState.plays = [];
      playState.nsTricks = 0;
      playState.ewTricks = 0;
      document.getElementById('playBoard').style.display = 'block';
      fetchSolve();
    }

    function resetPlay() {
      playState.plays = [];
      playState.nsTricks = 0;
      playState.ewTricks = 0;
      fetchSolve();
    }

    function undoPlay() {
      if (playState.plays.length === 0) return;
      playState.plays.pop();
      // Recalculate tricks: need server to tell us
      // For simplicity, reset trick count and re-derive from play length
      // Actually we need to track trick boundaries. Simpler: just refetch.
      playState.nsTricks = 0;
      playState.ewTricks = 0;
      fetchSolve();
    }

    async function fetchSolve() {
      try {
        const resp = await fetch('/solve', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            pbn: playState.pbn,
            trump: playState.trump,
            first: playState.first,
            plays: playState.plays,
          }),
        });
        const data = await resp.json();
        if (!resp.ok) { showError(data.error || ['Solve failed']); return; }
        showError(null);
        renderPlayBoard(data);
      } catch (err) { showError([err.message]); }
    }

    function parseCard(cardStr) {
      // Card string like "♠A" or "♥K" — extract suit letter and rank
      const suitMap = {'♠':'S','♥':'H','♦':'D','♣':'C'};
      const suit = suitMap[cardStr[0]] || cardStr[0];
      const rank = cardStr.slice(1);
      return { suit, rank, str: cardStr };
    }

    function renderPlayBoard(data) {
      const needed = playState.level + 6;
      const moveMap = {};
      let bestTricks = -1;
      data.moves.forEach(m => {
        const c = parseCard(m.card);
        moveMap[c.suit + c.rank] = m.tricks;
        if (m.tricks > bestTricks) bestTricks = m.tricks;
      });

      // Render each hand
      DIRS.forEach(dir => {
        const container = document.getElementById('ph-cards-' + dir);
        container.innerHTML = '';
        const handStr = data.hands[dir] || '...';
        const suits = handStr.split('.');
        const handEl = document.getElementById('ph-' + dir);
        handEl.classList.toggle('active-player', dir === data.curplayer);

        SUIT_ORDER.forEach((s, si) => {
          const cards = suits[si] || '';
          if (!cards) return;
          const row = document.createElement('div');
          row.className = 'play-suit';
          row.innerHTML = '<span class="suit-sym ' + SUIT_CLASS[s] + '">' + SUIT_SYM[s] + '</span>';
          for (const rank of cards) {
            const key = s + rank;
            const btn = document.createElement('span');
            btn.className = 'play-card';
            const tricks = moveMap[key];
            if (tricks !== undefined) {
              btn.classList.add('playable');
              if (tricks === bestTricks) btn.classList.add('best');
              // Show relative to contract: tricks won by declarer's side minus needed
              const isDecNS = (playState.declarer === 'N' || playState.declarer === 'S');
              const isCurNS = (data.curplayer === 'N' || data.curplayer === 'S');
              const totalTricksLeft = 13 - playState.nsTricks - playState.ewTricks;
              let decTricks;
              if (isDecNS === isCurNS) {
                decTricks = (isDecNS ? playState.nsTricks : playState.ewTricks) + tricks;
              } else {
                decTricks = (isDecNS ? playState.nsTricks : playState.ewTricks) + (totalTricksLeft - tricks);
              }
              const diff = decTricks - needed;
              let hintText, hintColor;
              if (diff === 0) { hintText = '='; hintColor = '#1a5276'; }
              else if (diff > 0) { hintText = '+' + diff; hintColor = '#1a8040'; }
              else { hintText = '' + diff; hintColor = '#c0392b'; }
              btn.innerHTML = rank + '<span class="dd-hint" style="color:' + hintColor + '">' + hintText + '</span>';
              btn.onclick = () => playCard(SUIT_SYM[s] + rank);
            } else {
              btn.textContent = rank;
            }
            row.appendChild(btn);
          }
          container.appendChild(row);
        });
      });

      // Render trick area
      DIRS.forEach(dir => {
        document.getElementById('tc-' + dir).textContent = '';
      });
      data.curtrick.forEach((cardStr, i) => {
        const firstIdx = DIRS.indexOf(data.curplayer);
        // curtrick cards are played starting from deal.first
        // We need to figure out which player played each card
        // The first card in curtrick was played by the leader of this trick
        // We reconstruct from the number of plays mod 4
        const trickStart = playState.plays.length - data.curtrick.length;
        const leaderOfTrick = data.curplayer; // curplayer is NEXT to play, not leader
        // Actually curplayer = first.next(len(curtrick))
        // So leader = curplayer rotated back by curtrick.length
        const playerOrder = ['N','E','S','W'];
        const curIdx = playerOrder.indexOf(data.curplayer);
        const leaderIdx = (curIdx - data.curtrick.length + 4) % 4;
        const whoPlayed = playerOrder[(leaderIdx + i) % 4];
        document.getElementById('tc-' + whoPlayed).textContent = cardStr;
      });

      // Update trick count from play history
      const totalTricks = Math.floor(playState.plays.length / 4);
      document.getElementById('play-ns').textContent = playState.nsTricks;
      document.getElementById('play-ew').textContent = playState.ewTricks;

      const status = document.getElementById('play-status');
      const trumpSym = SUIT_SYM[playState.trump] || 'NT';
      const contractStr = playState.level + trumpSym + ' by ' + DIR_NAMES[playState.declarer];
      if (data.moves.length === 0) {
        const needed = playState.level + 6;
        const decSide = (playState.declarer === 'N' || playState.declarer === 'S') ? playState.nsTricks : playState.ewTricks;
        const made = decSide >= needed ? 'Made!' : 'Down ' + (needed - decSide);
        status.textContent = contractStr + ' — ' + made;
      } else {
        status.textContent = contractStr + ' | ' + data.curplayer + ' to play';
      }
    }

    async function playCard(cardStr) {
      const prevTrickLen = playState.plays.length % 4;
      playState.plays.push(cardStr);

      // If this completes a trick (4th card), we need to track who won
      // We'll let the server figure it out by comparing curtrick before/after
      if (playState.plays.length % 4 === 0) {
        // A trick just completed — fetch to find out who won
        // We peek: the server will have cleared curtrick and updated first
        const resp = await fetch('/solve', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            pbn: playState.pbn, trump: playState.trump,
            first: playState.first, plays: playState.plays,
          }),
        });
        const data = await resp.json();
        if (!resp.ok) { showError(data.error || ['Error']); playState.plays.pop(); return; }
        // The new curplayer is the trick winner — determine side
        if (data.curplayer === 'N' || data.curplayer === 'S') playState.nsTricks++;
        else playState.ewTricks++;
        showError(null);
        renderPlayBoard(data);
      } else {
        fetchSolve();
      }
    }
  </script>
</body>
</html>
`;
