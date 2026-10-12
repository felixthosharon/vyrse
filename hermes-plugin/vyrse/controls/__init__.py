"""`vyrse_controls`: media keys, now playing, volume, brightness, lock and clipboard (Windows APIs, no windows)."""
from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path
from typing import Any, Dict

_SCRIPT = Path(__file__).resolve().parent / "controls.ps1"

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_controls",
    "description": (
        "Instant PC controls. action=media (command play_pause|next|previous|stop: works with Spotify, YouTube, "
        "any player); now_playing (what's playing, which app); volume (command get|set|up|down|mute|unmute|"
        "toggle_mute, level 0-100 for set or a step for up/down); brightness (level 0-100, or omit to read it); "
        "lock (lock the PC); screen_off (turn the monitors off, e.g. bedtime; a key or the mouse wakes them); clipboard_get (what the user copied: text, files, whether it's an image); "
        "clipboard_set (text: put text on the clipboard, e.g. after fixing or translating what they copied). "
        "For 'summarise/translate/fix what I copied', read it with clipboard_get first."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["media", "now_playing", "volume", "brightness", "lock", "screen_off",
                                                  "clipboard_get", "clipboard_set"]},
            "command": {"type": "string", "description": "media: play_pause|next|previous|stop; volume: get|set|up|down|mute|unmute|toggle_mute."},
            "level": {"type": "number", "description": "volume set (0-100) or up/down step; brightness 0-100."},
            "text": {"type": "string", "description": "For clipboard_set."},
        },
        "required": ["action"],
    },
}


def run(request: Dict[str, Any], timeout: int = 20) -> Dict[str, Any]:
    from hermes_cli._subprocess_compat import windows_hide_flags

    payload = base64.b64encode(json.dumps(request).encode("utf-8")).decode("ascii")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", str(_SCRIPT), "-Request", payload],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
        stdin=subprocess.DEVNULL, creationflags=windows_hide_flags(),
    )
    lines = [line for line in (result.stdout or "").splitlines() if line.strip().startswith("{")]
    if lines:
        return json.loads(lines[-1])
    detail = (result.stderr or result.stdout or "no output").strip().splitlines()
    return {"ok": False, "error": f"controls helper failed: {detail[0] if detail else 'unknown error'}"}


def handle(params: Dict[str, Any], **_: Any) -> str:
    request = {k: params[k] for k in ("action", "command", "level", "text") if params.get(k) is not None}
    try:
        return json.dumps(run(request), ensure_ascii=False)
    except subprocess.TimeoutExpired:
        return json.dumps({"ok": False, "error": "Windows didn't respond in time."})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"Couldn't do that: {exc}"})
