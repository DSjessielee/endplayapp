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
- If a suit is void (no cards, shown as — or empty), leave it empty
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

// --- DDS analysis proxy to Render ---

async function handleAnalyze(request) {
  const body = await request.text();

  const resp = await fetch(DDS_API + "/analyze", {
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
  <title>FunBridge - Double Dummy Analyzer</title>
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
    .auto-status { font-size: 0.75rem; color: #8cf; min-height: 1em; text-align: center; }
    .results-panel { width: 100%; max-width: 480px; }
    .results-title { font-size: 1.05rem; font-weight: 600; margin-bottom: 10px; color: #8fc; }
    .result-list { list-style: none; }
    .result-item { padding: 10px 14px; margin-bottom: 7px; background: #0d2818; border-radius: 8px; border-left: 4px solid #3a6; font-size: 0.9rem; line-height: 1.5; }
    .result-item .strain { font-weight: 700; font-size: 1rem; }
    .result-item .strain.red { color: #f66; } .result-item .strain.black { color: #fff; } .result-item .strain.nt { color: #8cf; }
    .result-item .tricks { color: #ccc; font-size: 0.82rem; margin-top: 2px; }
    .pbn-output { margin-top: 14px; padding: 8px 12px; background: #0d2818; border-radius: 8px; font-family: 'SF Mono', 'Consolas', monospace; font-size: 0.72rem; color: #8fc; word-break: break-all; }
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
  <h1>FunBridge Double Dummy Analyzer</h1>
  <p class="subtitle">Enter cards by suit, or upload a screenshot</p>
  <div class="main-container">
    <div style="width:100%; display:flex; flex-direction:column; align-items:center;">
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
    </div>
  </div>
  <div id="errorBox" class="error-msg" style="display:none;"></div>
  <script>
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
        const resp = await fetch('/analyze', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(hands) });
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
          canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.8);
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
      formData.append('image', resized, 'hand.jpg');
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
