"""`vyrse_desktop`: operate Windows apps in the background through UI Automation.

Opening apps, typing into text fields, reading a window's text and pressing named buttons happen without
moving the mouse, typing on the keyboard or bringing windows to the front, so the user can keep using
their PC. `computer_use` (screenshots + clicks) remains the fallback for what this can't reach.
"""
from __future__ import annotations

import base64
import json
import re
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
        "in a window); click (window, name = the button/menu item/tab: its label, or what it looks like or does for "
        "icon buttons, e.g. 'the gear icon', 'share'; VYRSE looks at the window to find the right one); focus (bring a window to "
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
            "name": {"type": "string", "description": "For click: the control's label, or a description of an icon button."},
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


# Accessible names spell out digits and symbols (Calculator: "Nine", "Multiply by", "Equals").
_SPOKEN = {"0": "Zero", "1": "One", "2": "Two", "3": "Three", "4": "Four", "5": "Five", "6": "Six", "7": "Seven",
           "8": "Eight", "9": "Nine", "+": "Plus", "-": "Minus", "*": "Multiply by", "x": "Multiply by",
           "×": "Multiply by", "/": "Divide by", "÷": "Divide by", "=": "Equals", ".": "Decimal separator", "%": "Percent"}
_last_window = ""  # the app VYRSE last opened or switched to: where "type this" goes when no window is named
_FRESH = ("notepad",)  # editors that restore old tabs: "open notepad" gets a new blank one


def _named_file(title: str) -> bool:
    """A window showing a real file (not a new, untitled one)."""
    t = title.lstrip("*").strip().lower()
    return bool(t) and not t.startswith(("untitled", "new tab")) and bool(re.search(r"\.\w{1,5}\b", t))


def handle(params: Dict[str, Any], **_: Any) -> str:
    global _last_window
    action = params.get("action")
    if action not in ACTIONS:
        return json.dumps({"ok": False, "error": f"unknown action {action!r}"})
    request = {k: params[k] for k in ("action", "target", "window", "text", "mode", "name", "position", "keys") if params.get(k) is not None}
    if action in ("type", "read", "click", "keys", "close", "focus", "arrange") and not request.get("window") and _last_window:
        request["window"] = _last_window
    try:
        if action == "type" and request.get("mode") == "replace" and request.get("window"):
            listed = run({"action": "windows"}).get("windows") or []
            q = str(request["window"]).lower().lstrip("*")
            title = next((w["title"] for w in listed if q in w["title"].lower() or q == str(w.get("app", "")).lower()), "")
            if _named_file(title):
                from ..confirm import ask

                name = title.lstrip("*").split(" - ")[0]
                if ask(f"Replace everything in {name}?", ["Replace it", "No, keep it"]) != "Replace it":
                    return json.dumps({"ok": False, "error": f"Left {name} as it was (the user said no). Open a new blank one instead, or add to the end."})
        if action == "click" and request.get("name") and request.get("window"):
            # Decide which control is meant by looking at the window (icons included), then press that one.
            from ..point import find, ghost_to

            name = str(request["name"]).strip()
            hit = find(_SPOKEN.get(name.lower(), name), str(request["window"]))
            if not hit.get("ok"):
                return json.dumps({"ok": False, "error": hit.get("error"), "visible_labels": hit.get("labels"),
                                   "note": "Nothing clicked. Don't guess: say what you can see, or look up where it is."},
                                  ensure_ascii=False)
            r = hit["rect"]
            ghost_to(r, f"Clicking {hit.get('name') or request['name']}"[:60])
            request.update(x=r["x"] + r["width"] // 2, y=r["y"] + r["height"] // 2, name=hit.get("name") or request["name"])
        result = run(request)
        if action == "open" and result.get("ok"):
            target = str(request.get("target") or "").lower().removesuffix(".exe")
            opened = str(result.get("opened") or "")
            if target in _FRESH and _named_file(opened):
                run({"action": "keys", "window": result.get("app") or target, "keys": "ctrl+n"})
                result["opened"] = "Untitled (a new blank tab)"
                result["note"] = "It reopened old tabs, so I made a new blank one; type there."
            _last_window = str(result.get("app") or target)
        elif action == "focus" and result.get("ok"):
            _last_window = str(request.get("window") or "")
        return json.dumps(result, ensure_ascii=False)
    except subprocess.TimeoutExpired:
        return json.dumps({"ok": False, "error": "The app didn't respond in time."})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"Couldn't do that: {exc}"})
