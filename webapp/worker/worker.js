/**
 * Cloudflare Worker — serves frontend + proxies Claude API + proxies DDS API.
 * Single Worker handles everything for funbridge.cc
 *
 * Deploy: cd webapp/worker && npx wrangler deploy
 * Set secret: npx wrangler secret put ANTHROPIC_API_KEY
 */

const DDS_API = 'https://bridge-dds-api.onrender.com';

const VISION_PROMPT = `This image shows a bridge hand diagram with four hands.

POSITIONS in the image:
- NORTH is the hand at the TOP CENTER of the image
- WEST is the hand on the LEFT SIDE of the image
- EAST is the hand on the RIGHT SIDE of the image
- SOUTH is the hand at the BOTTOM CENTER of the image

RULES:
- List cards by suit in order: spades.hearts.diamonds.clubs
- Convert ALL "10" to "T" (examples: K10→KT, A1097→AT97, Q10952→QT952, J109642→JT9642)
- Read EVERY card carefully — long suits can have 6-7 cards (e.g. J87642 is 6 cards, AKQ10765 is 7 cards). Do not skip any.
- If a suit is void (no cards, shown as — or empty), leave it empty
- Each hand must have exactly 13 cards total across all 4 suits
- Use only: A K Q J T 9 8 7 6 5 4 3 2
- Ignore any text like "Par", "NS", "EW", board numbers, vulnerability, or dealer info

Respond ONLY with exactly 4 lines, no other text:
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

// --- Proxy to Render ---

async function handleAnalyze(request) {
  return proxyToRender(request, "/analyze");
}

async function proxyToRender(request, path) {
  const body = await request.text();
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
}

// --- Helpers ---

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
      background: #1a472a; color: #f0f0f0;
      min-height: 100vh; min-height: -webkit-fill-available;
      display: flex; flex-direction: column; align-items: center;
      padding: 24px 16px;
      padding-top: env(safe-area-inset-top, 24px);
      padding-bottom: env(safe-area-inset-bottom, 24px);
    }
    h1 { font-size: 1.4rem; margin-bottom: 4px; color: #fff; }
    .subtitle { color: #aaa; font-size: 0.78rem; margin-bottom: 16px; }
    .main-container { display: flex; flex-direction: column; gap: 24px; align-items: center; max-width: 900px; width: 100%; }
    .compass {
      display: grid;
      grid-template-areas: ".     north ." "west  center east" ".     south .";
      grid-template-columns: 1fr auto 1fr; grid-template-rows: auto auto auto;
      gap: 6px; align-items: center; justify-items: center; width: 100%; max-width: 480px;
    }
    .hand-box.north { grid-area: north; } .hand-box.east { grid-area: east; }
    .hand-box.south { grid-area: south; } .hand-box.west { grid-area: west; }
    .center-box { grid-area: center; display: flex; align-items: center; justify-content: center; }
    .compass-rose {
      width: 60px; height: 60px; border: 2px solid #4a8; border-radius: 8px;
      display: grid; grid-template-areas: ". n ." "w . e" ". s .";
      grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1fr 1fr 1fr;
      font-weight: bold; font-size: 0.85rem; color: #4a8; background: #1a472a; flex-shrink: 0;
    }
    .compass-rose span { display: flex; align-items: center; justify-content: center; }
    .compass-rose .cr-n { grid-area: n; } .compass-rose .cr-s { grid-area: s; }
    .compass-rose .cr-e { grid-area: e; } .compass-rose .cr-w { grid-area: w; }
    .hand-box { background: #0d2818; border: 2px solid #3a6; border-radius: 8px; padding: 8px 10px; width: 100%; max-width: 170px; min-width: 110px; }
    .hand-box.auto-filled { border-color: #47b; }
    .hand-title { text-align: center; font-weight: 600; font-size: 0.82rem; color: #8fc; margin-bottom: 5px; }
    .suit-row { display: flex; align-items: center; margin-bottom: 3px; }
    .suit-row:last-child { margin-bottom: 0; }
    .suit-symbol { width: 20px; font-size: 1.1rem; text-align: center; flex-shrink: 0; }
    .suit-symbol.spade { color: #ccc; } .suit-symbol.heart { color: #f55; }
    .suit-symbol.diamond { color: #f80; } .suit-symbol.club { color: #5b5; }
    .suit-input {
      flex: 1; min-width: 0; padding: 6px 6px; border: 1px solid #3a6; border-radius: 4px;
      background: #162e1e; color: #fff; font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
      font-size: 0.88rem; outline: none; text-transform: uppercase;
      -webkit-appearance: none; appearance: none;
    }
    .suit-input:focus { border-color: #6f8; background: #1a3a22; }
    .suit-input.error { border-color: #e55; }
    .suit-input.auto-filled { color: #8cf; border-color: #47b; }
    .controls { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; align-items: center; width: 100%; max-width: 480px; }
    .btn-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; width: 100%; }
    button {
      padding: 10px 20px; border: none; border-radius: 8px; font-size: 0.9rem; font-weight: 600;
      cursor: pointer; transition: background 0.2s, transform 0.1s;
      -webkit-tap-highlight-color: transparent; touch-action: manipulation;
    }
    button:active { transform: scale(0.95); }
    .btn-analyze { background: #2a7; color: #fff; flex: 1; min-width: 100px; }
    .btn-analyze:hover { background: #3b8; }
    .btn-analyze:disabled { background: #555; cursor: not-allowed; }
    .btn-clear { background: #555; color: #fff; } .btn-clear:hover { background: #666; }
    .btn-upload { background: #36a; color: #fff; font-size: 0.84rem; } .btn-upload:hover { background: #47b; }
    .btn-swap { background: #864; color: #fff; font-size: 0.75rem; padding: 7px 10px; }
    .btn-swap:hover { background: #975; }
    .swap-row { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
    #imageInput { display: none; }
    .tabs { display: flex; gap: 0; margin-bottom: 16px; }
    .tab { padding: 10px 24px; background: #0d2818; color: #8fc; border: 2px solid #3a6; border-bottom: none; border-radius: 8px 8px 0 0; cursor: pointer; font-weight: 600; font-size: 0.9rem; -webkit-tap-highlight-color: transparent; }
    .tab.active { background: #1a472a; color: #fff; border-color: #4a8; }
    .tab-content { display: none; width: 100%; }
    .tab-content.active { display: flex; flex-direction: column; align-items: center; }
    .score-form { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 360px; }
    .score-row { display: flex; align-items: center; gap: 10px; }
    .score-row label { width: 90px; font-size: 0.85rem; color: #8fc; flex-shrink: 0; }
    .score-select, .score-num { padding: 8px 10px; border: 1px solid #3a6; border-radius: 6px; background: #162e1e; color: #fff; font-size: 0.9rem; outline: none; -webkit-appearance: none; appearance: none; }
    .score-select { flex: 1; }
    .score-num { width: 70px; text-align: center; }
    .score-result { margin-top: 16px; padding: 16px; background: #0d2818; border-radius: 8px; border-left: 4px solid #3a6; text-align: center; }
    .score-points { font-size: 2rem; font-weight: 700; }
    .score-points.positive { color: #4c8; }
    .score-points.negative { color: #f66; }
    .score-contract { font-size: 0.85rem; color: #aaa; margin-top: 4px; }
    .auto-status { font-size: 0.75rem; color: #8cf; min-height: 1em; text-align: center; }
    .results-panel { width: 100%; max-width: 480px; }
    .results-title { font-size: 1.05rem; font-weight: 600; margin-bottom: 10px; color: #8fc; }
    .result-list { list-style: none; }
    .result-item { padding: 10px 14px; margin-bottom: 7px; background: #0d2818; border-radius: 8px; border-left: 4px solid #3a6; font-size: 0.9rem; line-height: 1.5; }
    .result-item .strain { font-weight: 700; font-size: 1rem; }
    .result-item .strain.red { color: #f66; } .result-item .strain.black { color: #fff; } .result-item .strain.nt { color: #8cf; }
    .result-item .tricks { color: #ccc; font-size: 0.82rem; margin-top: 2px; }
    .par-result { margin-top: 10px; padding: 10px 14px; background: #0d2818; border-radius: 8px; border-left: 4px solid #f90; font-size: 0.9rem; line-height: 1.5; }
    .par-result .par-label { color: #fa0; font-weight: 700; }
    .par-result .par-score { color: #fff; font-weight: 700; font-size: 1.05rem; }
    .par-result .par-contracts { color: #ccc; font-size: 0.82rem; margin-top: 2px; }
    .setting-row { display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap; }
    .setting-row label { font-size: 0.82rem; color: #aaa; }
    .setting-row select { padding: 6px 8px; border: 1px solid #3a6; border-radius: 4px; background: #162e1e; color: #fff; font-size: 0.84rem; outline: none; -webkit-appearance: none; appearance: none; }
    .setting-row select:focus { border-color: #6f8; }
    .error-msg { color: #f88; background: #3a1111; padding: 10px 14px; border-radius: 8px; font-size: 0.82rem; margin-top: 8px; width: 100%; max-width: 480px; }
    .spinner { display: none; margin: 8px auto; width: 24px; height: 24px; border: 3px solid #333; border-top: 3px solid #4a8; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (min-width: 700px) {
      .main-container { flex-direction: row; flex-wrap: wrap; justify-content: center; align-items: flex-start; gap: 32px; }
      .compass { max-width: 480px; grid-template-columns: 170px auto 170px; }
      .hand-box { max-width: 170px; } .results-panel { max-width: 360px; }
    }
    @media (max-width: 390px) {
      body { padding: 16px 10px; } h1 { font-size: 1.2rem; } .compass { gap: 4px; }
      .hand-box { padding: 6px 6px; min-width: 95px; max-width: 140px; }
      .hand-title { font-size: 0.75rem; margin-bottom: 3px; }
      .suit-symbol { width: 16px; font-size: 0.95rem; } .suit-input { padding: 5px 4px; font-size: 0.82rem; }
      .compass-rose { width: 48px; height: 48px; font-size: 0.75rem; }
      button { padding: 10px 14px; font-size: 0.84rem; } .result-item { padding: 8px 10px; font-size: 0.84rem; }
    }
    @media (min-width: 391px) and (max-width: 699px) {
      .compass { grid-template-columns: 1fr auto 1fr; }
      .hand-box { max-width: 160px; } .compass-rose { width: 56px; height: 56px; }
    }
  </style>
</head>
<body>
  <h1>Bridge Double Dummy Analyzer</h1>
  <div class="tabs">
    <div class="tab active" onclick="switchTab('dds')">DD Analyzer</div>
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
          <div class="suit-row"><span class="suit-symbol spade">♠</span><input class="suit-input" data-dir="W" data-suit="0" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol heart">♥</span><input class="suit-input" data-dir="W" data-suit="1" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol diamond">♦</span><input class="suit-input" data-dir="W" data-suit="2" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol club">♣</span><input class="suit-input" data-dir="W" data-suit="3" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
        </div>
        <div class="center-box"><div class="compass-rose"><span class="cr-n">N</span><span class="cr-w">W</span><span class="cr-e">E</span><span class="cr-s">S</span></div></div>
        <div class="hand-box east" id="box-east">
          <div class="hand-title">East</div>
          <div class="suit-row"><span class="suit-symbol spade">♠</span><input class="suit-input" data-dir="E" data-suit="0" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol heart">♥</span><input class="suit-input" data-dir="E" data-suit="1" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol diamond">♦</span><input class="suit-input" data-dir="E" data-suit="2" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol club">♣</span><input class="suit-input" data-dir="E" data-suit="3" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
        </div>
        <div class="hand-box south" id="box-south">
          <div class="hand-title">South</div>
          <div class="suit-row"><span class="suit-symbol spade">♠</span><input class="suit-input" data-dir="S" data-suit="0" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol heart">♥</span><input class="suit-input" data-dir="S" data-suit="1" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol diamond">♦</span><input class="suit-input" data-dir="S" data-suit="2" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
          <div class="suit-row"><span class="suit-symbol club">♣</span><input class="suit-input" data-dir="S" data-suit="3" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" /></div>
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
    </div>
    <div class="results-panel" id="resultsPanel" style="display:none;">
      <div class="results-title">Double Dummy Results</div>
      <ul class="result-list" id="resultList"></ul>
      <div class="par-result" id="parResult" style="display:none;"></div>
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
  <div id="errorBox" class="error-msg" style="display:none;"></div>
  <script>
    function switchTab(tab) {
      document.querySelectorAll('.tab').forEach((t, i) => {
        t.classList.toggle('active', (tab === 'dds' && i === 0) || (tab === 'score' && i === 1));
      });
      document.getElementById('tab-dds').style.display = tab === 'dds' ? 'flex' : 'none';
      document.getElementById('tab-dds').classList.toggle('active', tab === 'dds');
      document.getElementById('tab-score').style.display = tab === 'score' ? 'flex' : 'none';
      document.getElementById('tab-score').classList.toggle('active', tab === 'score');
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
    function getInputs(dir) { return [0,1,2,3].map(s => document.querySelector('.suit-input[data-dir="'+dir+'"][data-suit="'+s+'"]')); }
    function getHand(dir) { return getInputs(dir).map(el => el.value.trim().toUpperCase()); }
    function setHand(dir, suits) {
      const inputs = getInputs(dir);
      suits.forEach((s, i) => { inputs[i].value = s; inputs[i].classList.add('auto-filled'); });
      document.getElementById('box-' + DIR_NAMES[dir].toLowerCase()).classList.add('auto-filled');
    }
    function handCardCount(dir) { return getHand(dir).join('').length; }
    function isHandComplete(dir) { return handCardCount(dir) === 13; }
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
        complete.forEach(dir => { for (const c of getHand(dir)[suit].toUpperCase()) allOfSuit.delete(c); });
        return Array.from(allOfSuit).sort((a,b) => ALL_RANKS.indexOf(a) - ALL_RANKS.indexOf(b)).join('');
      });
      if (remaining.reduce((s, r) => s + r.length, 0) !== 13) return;
      setHand(emptyDir, remaining);
      status.textContent = DIR_NAMES[emptyDir] + ' auto-filled with remaining cards';
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
      document.querySelectorAll('.suit-input').forEach(el => { el.value = ''; el.classList.remove('error', 'auto-filled'); });
      document.querySelectorAll('.hand-box').forEach(el => el.classList.remove('auto-filled'));
      document.getElementById('resultsPanel').style.display = 'none';
      document.getElementById('parResult').style.display = 'none';
      document.getElementById('autoStatus').textContent = '';
      showError(null);
    }
    async function analyze() {
      showError(null);
      document.getElementById('resultsPanel').style.display = 'none';
      document.querySelectorAll('.suit-input').forEach(el => el.classList.remove('error'));
      const hands = {};
      let hasError = false;
      DIRS.forEach(dir => {
        const h = getHand(dir).join('.');
        hands[dir] = h;
        if (h.replace(/\\./g, '').length !== 13) { getInputs(dir).forEach(el => el.classList.add('error')); hasError = true; }
      });
      if (hasError) { showError(['Each hand must have exactly 13 cards.']); return; }
      showSpinner(true);
      try {
        const payload = Object.assign({}, hands, {
          vul: document.getElementById('vulSelect').value,
          dealer: document.getElementById('dealerSelect').value,
        });
        const resp = await fetch('/analyze', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
        const data = await resp.json();
        if (!resp.ok) { showError(data.error || ['Analysis failed']); showSpinner(false); return; }
        const list = document.getElementById('resultList');
        list.innerHTML = '';
        const colorMap = {'\\u2663': 'black', '\\u2666': 'red', '\\u2665': 'red', '\\u2660': 'black', 'NT': 'nt'};
        data.results.forEach(r => {
          const li = document.createElement('li');
          li.className = 'result-item';
          li.innerHTML = '<div><span class="strain ' + (colorMap[r.symbol] || 'black') + '">' + r.symbol + ' ' + r.name + '</span></div>'
            + '<div class="tricks">N/S: <strong>' + r.ns + ' trick' + (r.ns !== 1 ? 's' : '') + '</strong> &nbsp;|&nbsp; E/W: <strong>' + r.ew + ' trick' + (r.ew !== 1 ? 's' : '') + '</strong></div>'
            + '<div class="tricks">N: ' + r.north + ' &nbsp; E: ' + r.east + ' &nbsp; S: ' + r.south + ' &nbsp; W: ' + r.west + '</div>';
          list.appendChild(li);
        });
        var parDiv = document.getElementById('parResult');
        if (data.par && data.par.score !== null) {
          var sign = data.par.score >= 0 ? '+' : '';
          var contracts = data.par.contracts.length > 0 ? data.par.contracts.join(', ') : '—';
          parDiv.innerHTML = '<div><span class="par-label">Par</span> &nbsp;<span class="par-score">N/S ' + sign + data.par.score + '</span></div><div class="par-contracts">' + contracts + '</div>';
          parDiv.style.display = 'block';
        } else {
          parDiv.style.display = 'none';
        }
        document.getElementById('resultsPanel').style.display = 'block';
        document.getElementById('resultsPanel').scrollIntoView({ behavior: 'smooth' });
      } catch (err) { showError([err.message]); }
      showSpinner(false);
    }
    function resizeImage(file, maxWidth) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          let w = img.width, h = img.height;
          if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          canvas.toBlob(blob => resolve(blob), 'image/png');
        };
        img.src = URL.createObjectURL(file);
      });
    }
    async function uploadImage(input) {
      if (!input.files || !input.files[0]) return;
      showError(null);
      showSpinner(true);
      document.getElementById('autoStatus').textContent = 'Extracting hands from image...';
      const resized = await resizeImage(input.files[0], 1200);
      const formData = new FormData();
      formData.append('image', resized, 'hand.png');
      try {
        const resp = await fetch('/extract-image', { method: 'POST', body: formData });
        const data = await resp.json();
        if (!resp.ok) { showError(data.error || ['Image extraction failed']); document.getElementById('autoStatus').textContent = ''; showSpinner(false); input.value = ''; return; }
        if (data.hands) {
          DIRS.forEach(dir => {
            const hand = data.hands[dir] || '';
            const suits = hand.split('.');
            const inputs = getInputs(dir);
            suits.forEach((s, i) => { if (inputs[i]) inputs[i].value = s; });
          });
          tryAutoPopulate();
          document.getElementById('autoStatus').textContent = 'Image loaded via ' + (data.method || 'Claude Vision');
        }
      } catch (err) { showError([err.message]); document.getElementById('autoStatus').textContent = ''; }
      showSpinner(false);
      input.value = '';
    }
    document.querySelectorAll('.suit-input').forEach(el => {
      el.addEventListener('input', () => {
        el.classList.remove('auto-filled');
        document.getElementById('box-' + DIR_NAMES[el.getAttribute('data-dir')].toLowerCase()).classList.remove('auto-filled');
        tryAutoPopulate();
      });
      el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.target.blur(); analyze(); } });
    });
  </script>
</body>
</html>`;
