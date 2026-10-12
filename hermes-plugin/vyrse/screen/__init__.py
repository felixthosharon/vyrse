"""`vyrse_screen`: read what's on the user's screen (the window behind VYRSE, or every monitor).

A screenshot plus Windows' built-in OCR (Windows.Media.Ocr), so it works with text-only local models;
no image leaves the PC. The last capture is kept at %HERMES_HOME%/vyrse/screen/last.png.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Dict

_HERE = Path(__file__).resolve().parent
_MAX_TEXT = 6000

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_screen",
    "description": (
        "Read what is on the user's screen right now: returns the title and app of the window they are "
        "looking at (the one behind VYRSE) and all text visible in it. Use it for 'what's on my screen', "
        "'read this', 'summarise this page/email/error', 'what does this say'. target=screen reads every "
        "monitor instead of one window. image=<path> reads the text in an image file instead (e.g. a "
        "screenshot or photo the user attached). To click or type, use computer_use instead."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "target": {"type": "string", "enum": ["window", "screen"], "description": "Default window."},
            "image": {"type": "string", "description": "Optional: path of an image file to read instead of the screen."},
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


def read_image(path: str) -> Dict[str, Any]:
    image = Path(path).expanduser()
    if not image.is_file():
        raise FileNotFoundError(f"no image at {path}")
    text = _run_ps("ocr.ps1", "-Path", str(image)).strip()
    return {"image": str(image), "text": text[:_MAX_TEXT] if text else "(no readable text)"}


def handle(params: Dict[str, Any], **_: Any) -> str:
    target = params.get("target") if params.get("target") in ("window", "screen") else "window"
    try:
        if params.get("image"):
            return json.dumps({"success": True, **read_image(str(params["image"]))}, ensure_ascii=False)
        return json.dumps({"success": True, **read_screen(target)}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"success": False, "error": f"Could not read the screen: {exc}"})
