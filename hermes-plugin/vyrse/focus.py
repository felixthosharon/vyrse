"""The focus guardian: during a study or work session, if the user drifts to YouTube, a game or social media for more
than ~45 seconds, VYRSE nudges them once (then leaves them alone for 10 minutes); at the end it says how it went.
It only looks at which window is in front (title and program), every few seconds, on this PC; nothing is stored.
"""
from __future__ import annotations

import contextvars
import ctypes
import json
import logging
import re
import threading
import time
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)
DISTRACTING = re.compile(r"youtube|instagram|tiktok|netflix|twitch|reddit|twitter|\bx\.com\b|facebook|prime video|disney\+|crunchyroll|9gag|pinterest", re.I)
TICK = 5.0
GRACE = 45.0
COOLDOWN = 600.0
_session: Dict[str, Any] = {}
_lock = threading.Lock()

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_focus",
    "description": (
        "The focus guardian for a study/work session: action=start (minutes, optional allow = apps or sites that are fine, "
        "e.g. 'youtube' for a lecture video) nudges the user once if they drift to games, YouTube or social media, and "
        "reports at the end; stop; status. Pair it with a workspace timer for 'study mode' / 'help me focus'."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["start", "stop", "status"]},
            "minutes": {"type": "number", "description": "For start: 5-240. Default 50."},
            "allow": {"type": "string", "description": "For start: comma-separated apps/sites that don't count as distractions."},
        },
        "required": ["action"],
    },
}


def _title(hwnd: int) -> str:
    n = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    ctypes.windll.user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def distraction(proc: str, exe: str, title: str, allow: list) -> Optional[str]:
    """What the user drifted to (a short name), or None if what's in front is fine."""
    from .usage import friendly, is_game

    hay = f"{proc} {title}".lower()
    if any(a and a in hay for a in allow):
        return None
    if is_game(proc, exe):
        return friendly(proc, exe)
    m = DISTRACTING.search(title or "")
    if m:
        return m.group(0).replace("twitter", "X").title() if m.group(0).lower() != "x.com" else "X"
    return None


def _say(text: str, title: str) -> None:
    from tools import desktop_ui

    desktop_ui.emit("vyrse.ui", {"action": "alert", "title": title, "text": text})


def _run(sid: float, minutes: float, allow: list) -> None:
    import psutil

    ends = time.time() + minutes * 60
    drift_since: Optional[float] = None
    last_nudge = 0.0
    while time.time() < ends:
        time.sleep(TICK)
        with _lock:
            if _session.get("id") != sid:
                return
        try:
            hwnd = ctypes.windll.user32.GetForegroundWindow()
            pid = ctypes.c_ulong()
            ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            p = psutil.Process(pid.value)
            what = distraction(p.name(), p.exe(), _title(hwnd), allow)
        except Exception:
            what = None
        now = time.time()
        if not what:
            drift_since = None
            continue
        drift_since = drift_since or now
        if now - drift_since >= GRACE and now - last_nudge >= COOLDOWN:
            last_nudge = now
            done = int((now - (ends - minutes * 60)) / 60)
            left = max(1, int((ends - now) / 60))
            with _lock:
                _session["nudges"] = _session.get("nudges", 0) + 1
            _say(f"Hey, {what} can wait. You're {done} minutes in, {left} to go. Back to it?", "Focus")
    with _lock:
        if _session.get("id") != sid:
            return
        nudges = _session.get("nudges", 0)
        _session.clear()
    _say(f"Focus session done: {int(minutes)} minutes" + (", no slips. Nice." if not nudges else f", {nudges} nudge{'s' if nudges > 1 else ''}. Good work."), "Focus done")


def handle(params: Dict[str, Any], **_: Any) -> str:
    action = params.get("action")
    if action == "start":
        minutes = max(5.0, min(240.0, float(params.get("minutes") or 50)))
        allow = [a.strip().lower() for a in str(params.get("allow") or "").split(",") if a.strip()]
        sid = time.time()
        with _lock:
            _session.clear()
            _session.update(id=sid, minutes=minutes, started=sid, allow=allow, nudges=0)
        ctx = contextvars.copy_context()  # the conversation/window this belongs to, for the nudges
        threading.Thread(target=ctx.run, args=(_run, sid, minutes, allow), daemon=True, name="vyrse-focus").start()
        until = time.strftime("%H:%M", time.localtime(sid + minutes * 60))
        return json.dumps({"ok": True, "guarding": f"{int(minutes)} min", "until": until,
                           "note": "Running quietly; VYRSE will speak up only if they drift. Reply in one line."})
    if action == "stop":
        with _lock:
            was = bool(_session)
            _session.clear()
        return json.dumps({"ok": True, "stopped": was})
    if action == "status":
        with _lock:
            s = dict(_session)
        if not s:
            return json.dumps({"ok": True, "active": False})
        left = max(0, int((s["started"] + s["minutes"] * 60 - time.time()) / 60))
        return json.dumps({"ok": True, "active": True, "minutes_left": left, "nudges": s.get("nudges", 0)})
    return json.dumps({"ok": False, "error": f"unknown action {action!r}"})
