"""DDS API backend — deploy to Render free tier.

Accepts a PBN string, returns double dummy results.
"""
from __future__ import annotations

import os
from pathlib import Path

from flask import Flask, request, jsonify
from flask_cors import CORS

from endplay.types import Deal, Denom, Player
from endplay.dds import calc_dd_table

app = Flask(__name__)
CORS(app)

VALID_RANKS = set("AKQJT98765432")
DENOM_NAMES = {
    Denom.clubs: ("♣", "Clubs"),
    Denom.diamonds: ("♦", "Diamonds"),
    Denom.hearts: ("♥", "Hearts"),
    Denom.spades: ("♠", "Spades"),
    Denom.nt: ("NT", "No Trump"),
}


def validate_hand(hand: str) -> list[str]:
    errors = []
    parts = hand.split(".")
    if len(parts) != 4:
        return [f"Expected 4 suits, got {len(parts)}"]
    total = sum(len(p) for p in parts)
    if total != 13:
        errors.append(f"Expected 13 cards, got {total}")
    for suit_name, cards in zip(["spades", "hearts", "diamonds", "clubs"], parts):
        for c in cards:
            if c not in VALID_RANKS:
                errors.append(f"Invalid rank '{c}' in {suit_name}")
    return errors


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/analyze", methods=["POST"])
def analyze():
    data = request.get_json()
    if not data:
        return jsonify({"error": ["No JSON body"]}), 400

    hands = {}
    errors = []
    for player in ["N", "E", "S", "W"]:
        raw = data.get(player, "").strip()
        if not raw:
            name = ["North", "East", "South", "West"]["NESW".index(player)]
            errors.append(f"{name} hand is empty")
            continue
        hand_errors = validate_hand(raw)
        if hand_errors:
            name = ["North", "East", "South", "West"]["NESW".index(player)]
            errors.extend(f"{name}: {e}" for e in hand_errors)
        hands[player] = raw

    if len(hands) != 4 or errors:
        return jsonify({"error": errors}), 400

    # Check for duplicates
    all_cards = []
    for player in "NESW":
        parts = hands[player].split(".")
        for suit_idx, cards in enumerate(parts):
            for card in cards:
                key = (suit_idx, card)
                if key in all_cards:
                    suit_name = ["spades", "hearts", "diamonds", "clubs"][suit_idx]
                    errors.append(f"Duplicate card: {card} of {suit_name}")
                all_cards.append(key)

    if errors:
        return jsonify({"error": errors}), 400

    pbn = "N:" + " ".join(hands[p] for p in "NESW")

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

    return jsonify({"pbn": pbn, "results": results, "hands": hands})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port)
