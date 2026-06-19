#!/usr/bin/env python3
"""Web app for bridge double dummy analysis.

Usage:
  set ANTHROPIC_API_KEY=sk-ant-...
  python webapp/app.py

Then open http://localhost:5000 in your browser.
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
import urllib.request
from pathlib import Path
from typing import Optional

from flask import Flask, render_template, request, jsonify

from endplay.types import Deal, Denom, Player, Vul, Contract, Hand
from endplay.dds import calc_dd_table
from endplay.dds.solve import solve_board, SolveMode
from endplay.dds.parscore import par
from endplay.evaluate import (hcp, dist_points, total_points, losers, controls,
                               shape, exact_shape, rule_of_n,
                               is_balanced, is_semibalanced, is_single_suited,
                               is_two_suited, is_three_suited)

app = Flask(__name__)
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


@app.after_request
def add_no_cache(response):
    response.headers["Cache-Control"] = "no-store"
    return response

VALID_RANKS = set("AKQJT98765432")
ALL_RANKS = "AKQJT98765432"
SUIT_SYMBOLS = {"♠": "S", "♥": "H", "♦": "D", "♣": "C",
                "♤": "S", "♡": "H", "♢": "D", "♧": "C"}
DENOM_NAMES = {
    Denom.clubs: ("♣", "Clubs"),
    Denom.diamonds: ("♦", "Diamonds"),
    Denom.hearts: ("♥", "Hearts"),
    Denom.spades: ("♠", "Spades"),
    Denom.nt: ("NT", "No Trump"),
}


# ---------------------------------------------------------------------------
# Claude Vision API extraction
# ---------------------------------------------------------------------------

VISION_PROMPT = (
    "This image shows a bridge hand diagram (likely a BBO screenshot). "
    "Extract the four hands: North, East, South, West.\n\n"
    "For each hand, list the cards by suit in this exact order: "
    "spades, hearts, diamonds, clubs.\n"
    "Use these rank abbreviations: A K Q J T 9 8 7 6 5 4 3 2 "
    "(use T for 10).\n"
    "If a suit is void (no cards), leave it empty.\n\n"
    "Respond ONLY with exactly 4 lines in this format, no other text:\n"
    "N: <spades>.<hearts>.<diamonds>.<clubs>\n"
    "E: <spades>.<hearts>.<diamonds>.<clubs>\n"
    "S: <spades>.<hearts>.<diamonds>.<clubs>\n"
    "W: <spades>.<hearts>.<diamonds>.<clubs>\n\n"
    "Example: N: AJ7.653.AK7.KJ76"
)


def extract_hands_via_claude(image_bytes: bytes, media_type: str) -> Optional[dict[str, str]]:
    """Use Claude Vision API to extract bridge hands from an image."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None

    image_data = base64.standard_b64encode(image_bytes).decode("utf-8")

    body = json.dumps({
        "model": "claude-haiku-4-5",
        "max_tokens": 300,
        "messages": [{"role": "user", "content": [
            {"type": "image", "source": {
                "type": "base64", "media_type": media_type, "data": image_data}},
            {"type": "text", "text": VISION_PROMPT},
        ]}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())

    text = result["content"][0]["text"]
    return _parse_hands_from_response(text)


def _parse_hands_from_response(text: str) -> Optional[dict[str, str]]:
    """Parse the structured N:/E:/S:/W: response from Claude."""
    hands: dict[str, str] = {}
    for line in text.strip().splitlines():
        m = re.match(r"^\s*([NESW])\s*:\s*(.+)$", line.strip())
        if not m:
            continue
        player = m.group(1)
        hand = m.group(2).strip()
        hand = hand.replace("10", "T")
        for symbol, letter in SUIT_SYMBOLS.items():
            hand = hand.replace(symbol, "")
        hand = re.sub(r"[^AKQJT2-9.]", "", hand)
        parts = hand.split(".")
        if len(parts) == 4:
            hands[player] = hand
    return hands if len(hands) >= 3 else None


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def normalize_hand(raw: str) -> Optional[str]:
    s = raw.strip()
    for symbol, letter in SUIT_SYMBOLS.items():
        s = s.replace(symbol, letter)
    s = s.replace("10", "T")

    if "." in s and not re.search(r"[SHDC]", s):
        parts = s.split(".")
        if len(parts) == 4 and all(all(c in VALID_RANKS for c in p) for p in parts):
            return s

    suits = {"S": "", "H": "", "D": "", "C": ""}
    suit_pattern = re.findall(r"([SHDC])([AKQJT2-9]*)", s)
    if len(suit_pattern) >= 4:
        for suit_char, cards in suit_pattern:
            if suit_char in suits:
                suits[suit_char] = cards
        return f"{suits['S']}.{suits['H']}.{suits['D']}.{suits['C']}"

    if "." in s:
        cleaned = re.sub(r"[^AKQJT2-9.]", "", s)
        parts = cleaned.split(".")
        if len(parts) == 4:
            return cleaned

    return None


def validate_hand(hand: str) -> list[str]:
    errors = []
    parts = hand.split(".")
    if len(parts) != 4:
        errors.append(f"Expected 4 suits, got {len(parts)}")
        return errors
    total = sum(len(p) for p in parts)
    if total != 13:
        errors.append(f"Expected 13 cards, got {total}")
    for suit_name, cards in zip(["spades", "hearts", "diamonds", "clubs"], parts):
        for c in cards:
            if c not in VALID_RANKS:
                errors.append(f"Invalid rank '{c}' in {suit_name}")
    return errors


def validate_deal(hands: dict[str, str]) -> list[str]:
    errors = []
    all_cards = []
    for player in "NESW":
        if player not in hands:
            errors.append(f"Missing {player} hand")
            continue
        for e in validate_hand(hands[player]):
            errors.extend([f"{player}: {e}"])
        parts = hands[player].split(".")
        for suit_idx, cards in enumerate(parts):
            for card in cards:
                all_cards.append((suit_idx, card))
    seen = set()
    for suit_idx, rank in all_cards:
        key = (suit_idx, rank)
        if key in seen:
            suit_name = ["spades", "hearts", "diamonds", "clubs"][suit_idx]
            errors.append(f"Duplicate card: {rank} of {suit_name}")
        seen.add(key)
    return errors


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/analyze", methods=["POST"])
def analyze():
    data = request.get_json()
    hands = {}
    errors = []

    for player in ["N", "E", "S", "W"]:
        raw = data.get(player, "").strip()
        if not raw:
            name = ["North", "East", "South", "West"]["NESW".index(player)]
            errors.append(f"{name} hand is empty")
            continue
        hand = normalize_hand(raw)
        if hand is None:
            name = ["North", "East", "South", "West"]["NESW".index(player)]
            errors.append(f"Could not parse {name} hand")
            continue
        hand_errors = validate_hand(hand)
        if hand_errors:
            name = ["North", "East", "South", "West"]["NESW".index(player)]
            errors.extend(f"{name}: {e}" for e in hand_errors)
        hands[player] = hand

    if len(hands) != 4:
        return jsonify({"error": errors}), 400

    deal_errors = validate_deal(hands)
    if deal_errors:
        return jsonify({"error": deal_errors}), 400

    pbn = "N:" + " ".join(hands[p] for p in "NESW")

    vul_str = data.get("vul", "none")
    dealer_str = data.get("dealer", "N")

    vul_map = {"none": Vul.none, "ns": Vul.ns, "ew": Vul.ew, "both": Vul.both}
    vul = vul_map.get(vul_str, Vul.none)

    dealer_map = {"N": Player.north, "E": Player.east, "S": Player.south, "W": Player.west}
    dealer = dealer_map.get(dealer_str, Player.north)

    try:
        deal = Deal(pbn)
        table = calc_dd_table(deal)
    except Exception as e:
        return jsonify({"error": [str(e)]}), 400

    results = []
    for denom in [Denom.clubs, Denom.diamonds, Denom.hearts, Denom.spades, Denom.nt]:
        symbol, name = DENOM_NAMES[denom]
        results.append({
            "symbol": symbol,
            "name": name,
            "north": table[denom, Player.north],
            "south": table[denom, Player.south],
            "east": table[denom, Player.east],
            "west": table[denom, Player.west],
            "ns": table[denom, Player.north],
            "ew": table[denom, Player.east],
        })

    try:
        par_result = par(table, vul, dealer)
        par_score = par_result.score
        par_contracts = [str(c) for c in par_result]
    except Exception:
        par_score = None
        par_contracts = []

    return jsonify({
        "pbn": pbn,
        "results": results,
        "hands": hands,
        "par": {"score": par_score, "contracts": par_contracts},
    })


@app.route("/score", methods=["POST"])
def score():
    data = request.get_json()
    if not data:
        return jsonify({"error": ["No JSON body"]}), 400

    level = data.get("level")
    suit = data.get("suit", "").upper()
    declarer = data.get("declarer", "N").upper()
    vulnerability = data.get("vulnerability", "none").lower()
    penalty = data.get("penalty", "").upper()
    result = data.get("result", 0)

    if not level or not suit:
        return jsonify({"error": ["Level and suit are required"]}), 400

    vul_map = {"none": Vul.none, "ns": Vul.ns, "ew": Vul.ew, "both": Vul.both, "all": Vul.both}
    vul = vul_map.get(vulnerability, Vul.none)

    try:
        contract_str = f"{level}{suit}{declarer}{penalty}"
        if result == 0:
            contract_str += "="
        else:
            contract_str += f"{result:+d}"

        contract = Contract(contract_str)
        points = contract.score(vul)

        return jsonify({
            "contract": str(contract),
            "score": points,
            "declarer": declarer,
            "vulnerability": vulnerability,
        })
    except Exception as e:
        return jsonify({"error": [str(e)]}), 400


@app.route("/solve", methods=["POST"])
def solve():
    data = request.get_json()
    if not data:
        return jsonify({"error": ["No JSON body"]}), 400

    pbn = data.get("pbn", "")
    trump_str = data.get("trump", "NT").upper()
    plays = data.get("plays", [])

    trump_map = {"S": Denom.spades, "H": Denom.hearts, "D": Denom.diamonds,
                 "C": Denom.clubs, "NT": Denom.nt, "N": Denom.nt}
    trump = trump_map.get(trump_str, Denom.nt)

    first_str = data.get("first", "N").upper()
    first_map = {"N": Player.north, "E": Player.east, "S": Player.south, "W": Player.west}
    first = first_map.get(first_str, Player.north)

    try:
        deal = Deal(pbn, first=first, trump=trump)
        for card_str in plays:
            deal.play(card_str)

        result = solve_board(deal, SolveMode.Default)
        moves = []
        for card, tricks in result:
            moves.append({"card": str(card), "tricks": tricks})

        curtrick = [str(c) for c in deal.curtrick]
        curplayer = deal.curplayer.abbr

        hands = {}
        for p in Player:
            hands[p.abbr] = str(deal[p])

        return jsonify({
            "moves": moves,
            "curplayer": curplayer,
            "curtrick": curtrick,
            "hands": hands,
        })
    except Exception as e:
        return jsonify({"error": [str(e)]}), 400


@app.route("/evaluate", methods=["POST"])
def evaluate():
    data = request.get_json()
    if not data:
        return jsonify({"error": ["No JSON body"]}), 400

    results = {}
    for player in ["N", "E", "S", "W"]:
        raw = data.get(player, "").strip()
        if not raw:
            continue
        try:
            hand = Hand(raw)
        except Exception:
            continue

        name = ["North", "East", "South", "West"]["NESW".index(player)]
        es = exact_shape(hand)
        desc = []
        if is_balanced(hand): desc.append("Balanced")
        elif is_semibalanced(hand): desc.append("Semi-balanced")
        elif is_three_suited(hand): desc.append("Three-suited")
        elif is_two_suited(hand): desc.append("Two-suited")
        elif is_single_suited(hand): desc.append("Single-suited")

        results[player] = {
            "name": name,
            "hcp": int(hcp(hand)),
            "dist_points": int(dist_points(hand)),
            "total_points": int(total_points(hand)),
            "losers": losers(hand),
            "controls": controls(hand),
            "rule_of_n": int(rule_of_n(hand)),
            "shape": "-".join(str(x) for x in es),
            "description": ", ".join(desc) if desc else "",
        }

    if not results:
        return jsonify({"error": ["No valid hands provided"]}), 400

    return jsonify({"evaluations": results})


@app.route("/extract-image", methods=["POST"])
def extract_image():
    if "image" not in request.files:
        return jsonify({"error": ["No image uploaded"]}), 400

    file = request.files["image"]
    image_bytes = file.read()

    ext = Path(file.filename or "").suffix.lower()
    media_types = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                   ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"}
    media_type = media_types.get(ext, "image/jpeg")

    if not os.environ.get("ANTHROPIC_API_KEY"):
        return jsonify({
            "error": ["ANTHROPIC_API_KEY not set. Start the server with:\n"
                      "  set ANTHROPIC_API_KEY=sk-ant-your-key\n"
                      "  python webapp/app.py"]
        }), 400

    try:
        hands = extract_hands_via_claude(image_bytes, media_type)
    except Exception as e:
        return jsonify({"error": [f"Claude API error: {e}"]}), 400

    if not hands:
        return jsonify({
            "error": ["Could not extract hands from image. "
                      "Please check the image is a bridge hand diagram."]
        }), 400

    warnings = []
    for d in "NESW":
        if d in hands:
            errs = validate_hand(hands[d])
            if errs:
                name = ["North", "East", "South", "West"]["NESW".index(d)]
                warnings.extend(f"{name}: {e}" for e in errs)

    return jsonify({"hands": hands, "method": "claude-vision", "warnings": warnings})


if __name__ == "__main__":
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("WARNING: ANTHROPIC_API_KEY not set. Image upload will not work.")
        print("  Set it with: set ANTHROPIC_API_KEY=sk-ant-your-key")
        print()
    print("Starting DDS Web App at http://localhost:5000")
    app.run(debug=True, port=5000)
