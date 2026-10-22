"""`vyrse_screen`: read what's on the user's screen (the window behind VYRSE, or every monitor).

A screenshot plus Windows' built-in OCR (Windows.Media.Ocr), so it works with text-only local models;
no image leaves the PC. The last capture is kept at %HERMES_HOME%/vyrse/screen/last.png.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List

_HERE = Path(__file__).resolve().parent
_MAX_TEXT = 6000

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_screen",
    "description": (
        "Read what is on the user's screen right now: returns the title and app of the window they are "
        "looking at (the one behind VYRSE) and all text visible in it. Use it for 'what's on my screen', "
        "'read this', 'summarise this page/email/error', 'what does this say'. target=screen reads every "
        "monitor instead of one window. image=<path> reads the text in an image file instead (e.g. a "
        "screenshot or photo the user attached). save=true also keeps the picture: 'take a screenshot' = target=screen, "
        "save=true (saved to Pictures/Screenshots; say where). To click or type, use computer_use instead."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "target": {"type": "string", "enum": ["window", "screen"], "description": "Default window."},
            "image": {"type": "string", "description": "Optional: path of an image file to read instead of the screen."},
            "save": {"type": "boolean", "description": "Keep a copy as a screenshot file (Pictures/Screenshots)."},
        },
    },
}


def _run_ps(script: str, *args: str, timeout: int = 30) -> str:
    from hermes_cli._subprocess_compat import windows_hide_flags

    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(_HERE / script), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
        stdin=subprocess.DEVNULL, creationflags=windows_hide_flags(),
    )
    if result.returncode != 0:
        lines = (result.stderr or result.stdout or "failed").strip().splitlines()
        message = next((line for line in lines if line.strip() and not line.startswith(("At ", "+", "    "))), lines[-1])
        raise RuntimeError(message.strip())
    return result.stdout


def read_screen(target: str = "window") -> Dict[str, Any]:
    from hermes_constants import get_hermes_home

    out_dir = Path(get_hermes_home()) / "vyrse" / "screen"
    out_dir.mkdir(parents=True, exist_ok=True)
    image = out_dir / "last.png"
    info = json.loads(_run_ps("capture.ps1", "-Target", target, "-Out", str(image)).strip().splitlines()[-1])
    text = _run_ps("ocr.ps1", "-Path", str(image)).strip()
    truncated = len(text) > _MAX_TEXT
    return {
        "window": info.get("title") or "",
        "app": info.get("process") or "",
        "text": text[:_MAX_TEXT] if text else "(no readable text)",
        **({"note": "text truncated"} if truncated else {}),
        "image": str(image),
    }


def reading_order(lines: List[Dict[str, Any]]) -> str:
    """OCR lines -> text row by row, as a person reads a photo. Windows OCR returns a receipt's item column and
    its price column as separate blocks ("Pizza / Bread / Rs 320 / Rs 138"), so a model pairs the wrong prices.
    Lines whose (de-skewed) centres sit on the same row are joined left to right; a hand-held photo is usually a
    little tilted, so the tilt is estimated from the words within each line first."""
    boxes = []
    slopes = []
    for line in lines:
        words = [w for w in line.get("words") or [] if w.get("width")]
        if not words:
            continue
        cx = [w["x"] + w["width"] / 2 for w in words]
        cy = [w["y"] + w["height"] / 2 for w in words]
        if len(words) >= 2 and cx[-1] - cx[0] > 20:
            slopes.append((cy[-1] - cy[0]) / (cx[-1] - cx[0]))
        boxes.append({"text": line.get("text") or " ".join(w["text"] for w in words), "x": min(w["x"] for w in words),
                      "cx": sum(cx) / len(cx), "cy": sum(cy) / len(cy), "h": max(w["height"] for w in words)})
    if not boxes:
        return ""
    slope = sorted(slopes)[len(slopes) // 2] if slopes else 0.0
    slope = max(-0.2, min(0.2, slope))
    for b in boxes:
        b["row_y"] = b["cy"] - slope * b["cx"]
    boxes.sort(key=lambda b: b["row_y"])
    h = sorted(b["h"] for b in boxes)[len(boxes) // 2] or 10
    rows: List[List[Dict[str, Any]]] = []
    for b in boxes:
        if rows and abs(b["row_y"] - rows[-1][-1]["row_y"]) <= 0.55 * h:
            rows[-1].append(b)
        else:
            rows.append([b])
    return "\n".join("   ".join(b["text"] for b in sorted(r, key=lambda b: b["x"])) for r in rows)


def read_image(path: str) -> Dict[str, Any]:
    image = Path(path).expanduser()
    if not image.is_file():
        raise FileNotFoundError(f"no image at {path}")
    raw = _run_ps("ocr.ps1", "-Path", str(image), "-Boxes").strip()
    try:
        data = json.loads(raw.splitlines()[-1]) if raw else []
        text = reading_order(data if isinstance(data, list) else [data])
    except (ValueError, KeyError, TypeError):
        text = _run_ps("ocr.ps1", "-Path", str(image)).strip()
    out: Dict[str, Any] = {"image": str(image), "text": text[:_MAX_TEXT] if text else "(no readable text)"}
    if re.search(r"\b(total|subtotal|amount due|bill|invoice|receipt|gst|vat)\b", text, re.I):
        out["note"] = ("This looks like a receipt or bill. 'Split it/this N ways' means the bill: the TOTAL divided by N "
                       "per person (show a table of who pays what). If a price was misread, work it out from the total.")
    return out


def save_copy(image: Path) -> str:
    """A kept copy of the capture, where Windows keeps screenshots."""
    import shutil
    import time

    home = Path(os.environ.get("USERPROFILE") or Path.home())
    pictures = next((p for p in (home / "OneDrive" / "Pictures", home / "Pictures") if p.is_dir()), home / "Pictures")
    folder = pictures / "Screenshots"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"VYRSE {time.strftime('%Y-%m-%d %H%M%S')}.png"
    shutil.copy(image, target)
    return str(target)


def handle(params: Dict[str, Any], **_: Any) -> str:
    target = params.get("target") if params.get("target") in ("window", "screen") else "window"
    try:
        if params.get("image"):
            return json.dumps({"success": True, **read_image(str(params["image"]))}, ensure_ascii=False)
        out = read_screen(target)
        if params.get("save"):
            out["saved"] = save_copy(Path(out["image"]))
            out["note"] = f"Screenshot saved to {out['saved']}. Say where, in a few words."
        return json.dumps({"success": True, **out}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"success": False, "error": f"Could not read the screen: {exc}"})
