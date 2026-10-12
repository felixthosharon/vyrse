"""`vyrse_phone`: the user's paired Android phone (the VYRSE app on it).

The request goes to whichever VYRSE window asked (desktop_call): on the PC it is relayed through the phone
bridge to the phone's link service; on the phone the app runs it itself.

Quick actions: battery, flashlight, ring to find it, media keys, media volume, show a notification, read the
notifications the user allowed. Full control (screen, tap, type, swipe, keys, open apps/links) works only
after the user turned on Android Accessibility AND "Allow full control" on the phone; the phone itself refuses
payment/banking/password apps and password fields, and asks for `confirmed` before anything that sends, pays,
deletes, installs or calls - which this tool turns into a yes/no question for the user on screen.
"""
from __future__ import annotations

import base64
import json
import time
from pathlib import Path
from typing import Any, Dict

ACTIONS = [
    "battery", "flashlight", "find", "media", "volume", "notifications", "notify",
    "screen", "screenshot", "tap", "long_press", "type", "swipe", "key", "open_app", "open_url",
]

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_phone",
    "description": (
        "The user's own Android phone (paired with VYRSE); only when they mean the PHONE. Quick: battery | "
        "flashlight (state on/off/toggle) | find (ring 30 s; state stop) | media (command) | volume (level 0-100) "
        "| notifications (what's in the shade) | notify (title, text). Full control (when the user allowed it on "
        "the phone): screen (numbered list of what's visible; read it before acting) | tap (n from screen, or "
        "text) | long_press | type (text into the selected field; submit yes to press enter) | swipe (direction "
        "up/down/left/right) | key (back/home/recents/notifications/quick_settings/lock) | open_app (name) | "
        "open_url (url) | screenshot (returns an image path for vision_analyze). Every action returns the new "
        "screen; tap rows, not their images; typing doesn't send. For app tasks load the vyrse-phone-control skill."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ACTIONS},
            "state": {"type": "string", "description": "flashlight: on/off/toggle; find: start/stop"},
            "command": {"type": "string", "enum": ["play_pause", "play", "pause", "next", "previous", "stop"]},
            "level": {"type": "integer", "minimum": 0, "maximum": 100},
            "limit": {"type": "integer", "minimum": 1, "maximum": 30},
            "n": {"type": "integer", "minimum": 1, "description": "item number from the last screen"},
            "text": {"type": "string", "description": "tap: visible text to tap; type: what to type; notify: body"},
            "title": {"type": "string"},
            "submit": {"type": "string", "enum": ["yes", "no"]},
            "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
            "key": {"type": "string", "enum": ["back", "home", "recents", "notifications", "quick_settings", "lock"]},
            "name": {"type": "string", "description": "open_app: the app's name"},
            "url": {"type": "string"},
            "x": {"type": "integer"},
            "y": {"type": "integer"},
        },
        "required": ["action"],
    },
}

_ARGS = ("state", "command", "level", "limit", "n", "text", "title", "submit", "direction", "key", "name", "url", "x", "y")
_KEEP_SHOTS = 5


def _save_screenshot(result: Dict[str, Any]) -> Dict[str, Any]:
    """Phone screenshots become files (the model reads them with vision_analyze); only the newest few are kept."""
    data = result.pop("jpeg_base64", None)
    if not data:
        return result
    from hermes_constants import get_hermes_home

    folder = Path(get_hermes_home()) / "vyrse" / "phone"
    folder.mkdir(parents=True, exist_ok=True)
    for old in sorted(folder.glob("screen-*.jpg"))[:-(_KEEP_SHOTS - 1)]:
        try:
            old.unlink()
        except OSError:
            pass
    path = folder / f"screen-{time.strftime('%Y%m%d-%H%M%S')}.jpg"
    path.write_bytes(base64.b64decode(data))
    result["image"] = str(path)
    result["note"] = "Look at it with vision_analyze if the picture matters."
    return result


def handle(params: Dict[str, Any], **_: Any) -> str:
    from .tools import _in_vyrse_session
    from . import confirm, desktop_call

    if not _in_vyrse_session():
        return json.dumps({"ok": False, "error": "vyrse_phone only works through the VYRSE app."})
    action = str(params.get("action") or "")
    if action not in ACTIONS:
        return json.dumps({"ok": False, "error": f"Unknown action {action!r}."})
    args = {k: params[k] for k in _ARGS if params.get(k) not in (None, "")}
    result = desktop_call.call("phone", action, args, timeout=25.0)
    # The phone refuses taps that could send, pay, delete, install or call until the user says yes.
    if result.get("needs_confirmation"):
        label = str(result.get("label") or "that")[:80]
        if confirm.ask(f"Let VYRSE tap “{label}” on your phone?", ["Tap it", "Cancel"]) != "Tap it":
            return json.dumps({"ok": False, "error": f"The user didn't approve tapping “{label}”."})
        result = desktop_call.call("phone", action, {**args, "confirmed": "yes"}, timeout=25.0)
    if action == "screenshot" and result.get("ok"):
        result = _save_screenshot(result)
    if action == "notifications" and result.get("ok") and not result.get("count"):
        result["note"] = "No notifications on the phone right now."
    return json.dumps(result, ensure_ascii=False)
