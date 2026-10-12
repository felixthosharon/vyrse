"""`vyrse_desktop`: operate Windows apps in the background through UI Automation.

Opening apps, typing into text fields, reading a window's text and pressing named buttons happen without
moving the mouse, typing on the keyboard or bringing windows to the front, so the user can keep using
their PC. `computer_use` (screenshots + clicks) remains the fallback for what this can't reach.
"""
from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path
from typing import Any, Dict

_SCRIPT = Path(__file__).resolve().parent / "desktop.ps1"
ACTIONS = ("windows", "open", "type", "read", "click", "focus", "close", "arrange", "keys")

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_desktop",
    "description": (
        "Operate Windows apps in the BACKGROUND, without the mouse or keyboard and without stealing focus. "
        "Prefer this over computer_use. Actions: windows (list open windows); open (target = app like "
        "notepad/calc/chrome, a file path or a URL); type (window, text; appends, or mode=replace); read (all text "
        "in a window); click (window, name = visible label of a button/menu item/tab); focus (bring a window to "
        "the front, only when the user wants to see it); close; arrange (window, position: left/right/top/bottom, "
        "top-left/top-right/bottom-left/bottom-right, left-third/middle-third/right-third, left-two-thirds/"
        "right-two-thirds, full, center, minimize, maximize, restore: 'tidy my windows' = one arrange per window, "
        "e.g. code left, chat right, music minimize); keys (window, keys like ctrl+s to save, alt+f4; brings that "
        "window forward). `window` = part of the title or the app name. "
        "If it reports it can't do something, fall back to computer_use."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(ACTIONS)},
            "target": {"type": "string", "description": "For open: app name, file path or URL."},
            "window": {"type": "string", "description": "For type/read/click/focus/close: title text or app name."},
            "text": {"type": "string", "description": "For type."},
            "mode": {"type": "string", "enum": ["append", "replace"], "description": "For type. Default append."},
            "name": {"type": "string", "description": "For click: the control's visible label."},
            "position": {"type": "string", "description": "For arrange."},
            "keys": {"type": "string", "description": "For keys, e.g. ctrl+s."},
        },
        "required": ["action"],
    },
}


def run(request: Dict[str, Any], timeout: int = 30) -> Dict[str, Any]:
    from hermes_cli._subprocess_compat import windows_hide_flags

    payload = base64.b64encode(json.dumps(request).encode("utf-8")).decode("ascii")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(_SCRIPT), "-Request", payload],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
        stdin=subprocess.DEVNULL, creationflags=windows_hide_flags(),
    )
    lines = [line for line in (result.stdout or "").splitlines() if line.strip().startswith("{")]
    if lines:
        return json.loads(lines[-1])
    detail = (result.stderr or result.stdout or "no output").strip().splitlines()
    return {"ok": False, "error": f"desktop helper failed: {detail[0] if detail else 'unknown error'}"}


def handle(params: Dict[str, Any], **_: Any) -> str:
    action = params.get("action")
    if action not in ACTIONS:
        return json.dumps({"ok": False, "error": f"unknown action {action!r}"})
    request = {k: params[k] for k in ("action", "target", "window", "text", "mode", "name", "position", "keys") if params.get(k) is not None}
    try:
        return json.dumps(run(request), ensure_ascii=False)
    except subprocess.TimeoutExpired:
        return json.dumps({"ok": False, "error": "The app didn't respond in time."})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"Couldn't do that: {exc}"})
