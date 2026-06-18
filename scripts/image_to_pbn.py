#!/usr/bin/env python3
"""Convert a bridge hand image into PBN format for double dummy analysis.

Usage:
  python scripts/image_to_pbn.py image.jpg
  python scripts/image_to_pbn.py image.jpg -o output.txt
  python scripts/image_to_pbn.py image.jpg --run-dds
  python scripts/image_to_pbn.py hand_text.txt

Supports:
  - BBO screenshots with suit symbols
  - Hand diagram images (N/S/E/W layout)
  - Text files with labeled hands
  - Claude Vision API for complex images (set ANTHROPIC_API_KEY env var)
  - OCR fallback via pytesseract

Output format (PBN):
  N:AJ7.653.AK7.KJ76 QT984.AJ92.J.A94 3.K.98632.QT32 K652.QT84.QT5.85

Each hand is spades.hearts.diamonds.clubs, in N E S W order.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
from pathlib import Path
from typing import Optional

VALID_RANKS = set("AKQJT98765432")
SUIT_SYMBOLS = {"♠": "S", "♥": "H", "♦": "D", "♣": "C",
                "♤": "S", "♡": "H", "♢": "D", "♧": "C"}
PLAYER_ALIASES = {
    "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W",
    "N": "N", "S": "S", "E": "E", "W": "W",
}
CLOCKWISE = {"N": ["N", "E", "S", "W"], "E": ["E", "S", "W", "N"],
              "S": ["S", "W", "N", "E"], "W": ["W", "N", "E", "S"]}


def normalize_hand(raw: str) -> Optional[str]:
    """Normalize a hand string to PBN suit format (spades.hearts.diamonds.clubs).

    Handles formats like:
      - 'AJ7.653.AK7.KJ76'  (already PBN)
      - 'SAJ7 H653 DAK7 CKJ76' (suit-prefixed)
      - '♠AJ7 ♥653 ♦AK7 ♣KJ76' (unicode suit symbols)
    """
    s = raw.strip()
    for symbol, letter in SUIT_SYMBOLS.items():
        s = s.replace(symbol, letter)

    s = s.replace("10", "T")

    # If it already looks like PBN (dots separating suits, no suit letters)
    if "." in s and not re.search(r"[SHDC]", s):
        parts = s.split(".")
        if len(parts) == 4 and all(all(c in VALID_RANKS for c in p) for p in parts):
            return s

    # Try suit-prefixed format: S... H... D... C...
    suits = {"S": "", "H": "", "D": "", "C": ""}
    suit_pattern = re.findall(r"([SHDC])([AKQJT2-9]*)", s)
    if len(suit_pattern) >= 4:
        for suit_char, cards in suit_pattern:
            if suit_char in suits:
                suits[suit_char] = cards
        return f"{suits['S']}.{suits['H']}.{suits['D']}.{suits['C']}"

    # Fallback: if it already has dots, try cleaning
    if "." in s:
        cleaned = re.sub(r"[^AKQJT2-9.]", "", s)
        parts = cleaned.split(".")
        if len(parts) == 4:
            return cleaned

    # Last resort: strip everything non-card, assume no dots means we can't parse suits
    cleaned = re.sub(r"[^AKQJT2-9]", "", s)
    if len(cleaned) == 13:
        # Can't determine suit boundaries without separators
        return None

    return None


def validate_hand(hand: str) -> list[str]:
    """Return a list of validation errors for a hand string."""
    errors = []
    parts = hand.split(".")
    if len(parts) != 4:
        errors.append(f"Expected 4 suits, got {len(parts)}")
        return errors

    total = sum(len(p) for p in parts)
    if total != 13:
        errors.append(f"Expected 13 cards, got {total}")

    for i, (suit_name, cards) in enumerate(zip(["spades", "hearts", "diamonds", "clubs"], parts)):
        for c in cards:
            if c not in VALID_RANKS:
                errors.append(f"Invalid rank '{c}' in {suit_name}")

    return errors


def validate_deal(hands: dict[str, str]) -> list[str]:
    """Validate that four hands form a legal 52-card deal."""
    errors = []
    all_cards = []
    for player in "NESW":
        if player not in hands:
            errors.append(f"Missing {player} hand")
            continue
        hand_errors = validate_hand(hands[player])
        if hand_errors:
            errors.extend(f"{player}: {e}" for e in hand_errors)
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

    if len(all_cards) != 52 and not errors:
        errors.append(f"Deal has {len(all_cards)} cards instead of 52")

    return errors


def parse_hands_from_text(text: str) -> Optional[dict[str, str]]:
    """Extract player hands from text containing labeled hands."""
    hands: dict[str, str] = {}
    norm = text
    for symbol, letter in SUIT_SYMBOLS.items():
        norm = norm.replace(symbol, letter)
    norm = norm.replace("10", "T")

    for m in re.finditer(
        r"\b(North|South|East|West|N|S|E|W)\b[:\s]+(.+?)(?=\b(?:North|South|East|West|N|S|E|W)\b[:\s]|\Z)",
        norm,
        flags=re.I | re.DOTALL
    ):
        player_raw = m.group(1).strip().upper()
        player = PLAYER_ALIASES.get(player_raw)
        if not player:
            continue
        raw_hand = m.group(2).strip().split("\n")[0].strip()
        hand = normalize_hand(raw_hand)
        if hand:
            hands[player] = hand

    return hands if len(hands) == 4 else None


def hands_to_pbn(hands: dict[str, str], first: str = "N") -> str:
    """Convert a dict of {player: hand} to PBN string."""
    order = CLOCKWISE[first]
    return f"{first}:" + " ".join(hands[p] for p in order)


# --- Claude Vision API ---

def extract_hands_via_claude(image_path: Path) -> Optional[dict[str, str]]:
    """Use Claude Vision API to extract bridge hands from an image."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None

    try:
        import httpx
    except ImportError:
        try:
            import urllib.request
            return _extract_hands_via_claude_urllib(image_path, api_key)
        except Exception:
            return None

    suffix = image_path.suffix.lower()
    media_types = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                   ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"}
    media_type = media_types.get(suffix, "image/jpeg")

    image_data = base64.standard_b64encode(image_path.read_bytes()).decode("utf-8")

    prompt = (
        "This image shows a bridge hand diagram. Extract the four hands (North, East, South, West). "
        "For each hand, list the cards by suit in this exact order: spades, hearts, diamonds, clubs. "
        "Use these rank abbreviations: A K Q J T 9 8 7 6 5 4 3 2 (use T for 10). "
        "If a suit is void (no cards), leave it empty. "
        "Respond ONLY with exactly 4 lines in this format, no other text:\n"
        "N: <spades>.<hearts>.<diamonds>.<clubs>\n"
        "E: <spades>.<hearts>.<diamonds>.<clubs>\n"
        "S: <spades>.<hearts>.<diamonds>.<clubs>\n"
        "W: <spades>.<hearts>.<diamonds>.<clubs>\n"
        "Example: N: AJ7.653.AK7.KJ76"
    )

    resp = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": "claude-sonnet-4-6",
            "max_tokens": 300,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image", "source": {
                        "type": "base64", "media_type": media_type, "data": image_data}},
                    {"type": "text", "text": prompt},
                ],
            }],
        },
        timeout=30,
    )
    resp.raise_for_status()
    text = resp.json()["content"][0]["text"]
    return parse_hands_from_text(text)


def _extract_hands_via_claude_urllib(image_path: Path, api_key: str) -> Optional[dict[str, str]]:
    """Fallback using urllib when httpx is not available."""
    import urllib.request

    suffix = image_path.suffix.lower()
    media_types = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                   ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"}
    media_type = media_types.get(suffix, "image/jpeg")

    image_data = base64.standard_b64encode(image_path.read_bytes()).decode("utf-8")

    prompt = (
        "This image shows a bridge hand diagram. Extract the four hands (North, East, South, West). "
        "For each hand, list the cards by suit in this exact order: spades, hearts, diamonds, clubs. "
        "Use these rank abbreviations: A K Q J T 9 8 7 6 5 4 3 2 (use T for 10). "
        "If a suit is void (no cards), leave it empty. "
        "Respond ONLY with exactly 4 lines in this format, no other text:\n"
        "N: <spades>.<hearts>.<diamonds>.<clubs>\n"
        "E: <spades>.<hearts>.<diamonds>.<clubs>\n"
        "S: <spades>.<hearts>.<diamonds>.<clubs>\n"
        "W: <spades>.<hearts>.<diamonds>.<clubs>\n"
        "Example: N: AJ7.653.AK7.KJ76"
    )

    body = json.dumps({
        "model": "claude-sonnet-4-6",
        "max_tokens": 300,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {
                    "type": "base64", "media_type": media_type, "data": image_data}},
                {"type": "text", "text": prompt},
            ],
        }],
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
    return parse_hands_from_text(text)


# --- OCR ---

def extract_hands_via_ocr(image_path: Path) -> Optional[dict[str, str]]:
    """Use pytesseract OCR to extract bridge hands from an image."""
    try:
        import cv2
        from PIL import Image
        import pytesseract
    except ImportError:
        return None

    img = cv2.imread(str(image_path))
    if img is None:
        return None

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    thresh = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY, 11, 2)

    variants = [
        gray,
        thresh,
        cv2.equalizeHist(gray),
        cv2.GaussianBlur(gray, (3, 3), 0),
    ]

    h, w = gray.shape
    if max(h, w) < 800:
        scaled = cv2.resize(gray, (w * 2, h * 2), interpolation=cv2.INTER_CUBIC)
        variants.append(scaled)

    best_hands = None
    try:
        for variant in variants:
            pil_img = Image.fromarray(variant)
            text = pytesseract.image_to_string(pil_img)
            hands = parse_hands_from_text(text)
            if hands:
                errors = validate_deal(hands)
                if not errors:
                    return hands
                if best_hands is None:
                    best_hands = hands
    except Exception:
        return best_hands

    return best_hands


# --- Main ---

def extract_hands(image_path: Path) -> tuple[dict[str, str], str]:
    """Extract hands from an image file using the best available method.

    Returns (hands_dict, method_used).
    """
    # If it's a text file, parse directly
    if image_path.suffix.lower() in (".txt", ".text"):
        text = image_path.read_text(encoding="utf-8")
        hands = parse_hands_from_text(text)
        if hands:
            return hands, "text"
        raise RuntimeError(f"Could not parse hands from text file: {image_path}")

    # Try Claude Vision API first (most reliable for complex images)
    claude_hands = None
    try:
        claude_hands = extract_hands_via_claude(image_path)
    except Exception as e:
        print(f"Claude Vision API error: {e}", file=sys.stderr)

    if claude_hands:
        errors = validate_deal(claude_hands)
        if not errors:
            return claude_hands, "claude-vision"
        print(f"Claude Vision result had validation issues: {errors}", file=sys.stderr)

    # Fall back to OCR
    ocr_hands = extract_hands_via_ocr(image_path)
    if ocr_hands:
        errors = validate_deal(ocr_hands)
        if not errors:
            return ocr_hands, "ocr"
        if not claude_hands:
            return ocr_hands, "ocr (with warnings)"

    # Return whichever result we got, preferring Claude
    if claude_hands:
        return claude_hands, "claude-vision (with warnings)"
    if ocr_hands:
        return ocr_hands, "ocr (with warnings)"

    hints = []
    if not os.environ.get("ANTHROPIC_API_KEY"):
        hints.append("Set ANTHROPIC_API_KEY for Claude Vision (most reliable)")
    hints.append("Install tesseract + pytesseract + opencv-python for OCR")
    hints.append("Or provide a .txt file with labeled hands instead")
    raise RuntimeError(
        "Could not extract hands from image.\n" +
        "\n".join(f"  - {h}" for h in hints)
    )


def run_dds(pbn: str) -> None:
    """Run double dummy analysis on the PBN string and print results."""
    try:
        from endplay.types import Deal
        from endplay.dds import calc_dd_table
    except ImportError:
        print("endplay not installed; cannot run DDS analysis.", file=sys.stderr)
        print("Install with: pip install endplay", file=sys.stderr)
        return

    import io
    utf8_out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

    deal = Deal(pbn)
    print("\nDeal:", file=utf8_out)
    deal.pprint(stream=utf8_out)
    print("\nDouble Dummy Table:", file=utf8_out)
    table = calc_dd_table(deal)
    table.pprint(stream=utf8_out)
    utf8_out.flush()


def prompt_manual_entry() -> dict[str, str]:
    """Prompt the user to enter hands interactively."""
    print("Enter each hand as: spades.hearts.diamonds.clubs")
    print("Use T for 10, leave suit empty for void (e.g. AK..QJT9764.AKT)")
    print("You can also use suit prefixes: SA1097 HQ6 D532 CQ832")
    print()

    hands: dict[str, str] = {}
    for player, name in [("N", "North"), ("E", "East"), ("S", "South"), ("W", "West")]:
        while True:
            raw = input(f"  {name}: ").strip()
            if not raw:
                continue
            hand = normalize_hand(raw)
            if hand is None:
                print(f"    Could not parse. Use format: AKQ.JT9.8765.432")
                continue
            errors = validate_hand(hand)
            if errors:
                print(f"    {'; '.join(errors)} — try again")
                continue
            hands[player] = hand
            break

    errors = validate_deal(hands)
    if errors:
        print(f"\nWarning - deal validation issues:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)

    return hands


def main() -> None:
    p = argparse.ArgumentParser(
        description="Convert a bridge hand image to PBN format for double dummy analysis"
    )
    p.add_argument("input", nargs="?", type=Path, help="Image file (.jpg/.png) or text file (.txt)")
    p.add_argument("-o", "--output", type=Path, help="Output file (default: stdout)")
    p.add_argument("--run-dds", action="store_true", help="Run double dummy analysis on result")
    p.add_argument("--first", default="N", choices=list("NESW"),
                   help="First player in PBN output (default: N)")
    p.add_argument("--format", choices=["pbn", "dds-file", "raw"], default="pbn",
                   help="Output format: pbn (default), dds-file (PBN 1 \"...\"), raw (no prefix)")
    p.add_argument("--manual", action="store_true",
                   help="Enter hands manually via prompts")
    args = p.parse_args()

    if args.manual or args.input is None:
        hands = prompt_manual_entry()
        method = "manual"
    else:
        if not args.input.exists():
            print(f"File not found: {args.input}", file=sys.stderr)
            sys.exit(1)
        try:
            hands, method = extract_hands(args.input)
        except RuntimeError as e:
            print(f"{e}", file=sys.stderr)
            print("\nFalling back to manual entry...\n", file=sys.stderr)
            hands = prompt_manual_entry()
            method = "manual (fallback)"

    pbn = hands_to_pbn(hands, args.first)

    errors = validate_deal(hands)
    if errors:
        print(f"Warning - validation issues:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)

    # Format output
    if args.format == "dds-file":
        output = f'PBN 1 "{pbn}"\n'
    elif args.format == "raw":
        # Just the hands, no player prefix
        output = pbn[2:] + "\n"
    else:
        output = pbn + "\n"

    if args.output:
        args.output.write_text(output)
        print(f"Wrote {args.format} to {args.output} (via {method})", file=sys.stderr)
    else:
        print(output, end="")

    print(f"Method: {method}", file=sys.stderr)

    if args.run_dds:
        run_dds(pbn)


if __name__ == "__main__":
    main()
