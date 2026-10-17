"""One-phrase routines: "study mode", "gaming mode", "bedtime", or any the user makes ("make a routine called
movie night that dims the screen, pauses notifications and plays my chill playlist"). A routine is a short list of
steps in plain words; saying its name runs them with VYRSE's own tools. Three starters come built in and can be
changed or removed like any other.
"""
from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

_LOCK = threading.Lock()
MAX = 16
STARTERS: Dict[str, str] = {
    "study mode": "Start a 50-minute focus timer in the workspace (vyrse_workspace kind=timer); put the phone on silent "
                  "(vyrse_phone volume 0); start the focus guardian for 50 minutes (vyrse_focus action=start).",
    "gaming mode": "Switch VYRSE to gaming mode (vyrse_ui mode gaming); watch the GPU temperature for 3 hours and ping "
                   "the phone above 85°C (vyrse_system action=watch metric=gpu_temp alert_above=85 notify_phone=true minutes=180).",
    "bedtime": "Set an alarm for when the user gets up (vyrse_reminders action=create alarm=true; ask once if you don't "
               "know the time); put the phone on silent (vyrse_phone volume 0); then turn the screen off (vyrse_controls screen_off).",
}

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_routine",
    "description": (
        "One-phrase routines. action=create: name (the phrase that runs it, e.g. 'movie night') + steps (YOU write them "
        "from what the user described: what to do, in order, naming the VYRSE tool for each); delete (name); list. "
        "Running one: when the user says a routine's name, do its steps with your tools, then confirm in one line."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["create", "delete", "list"]},
            "name": {"type": "string"},
            "steps": {"type": "string", "description": "For create: the steps, in order."},
        },
        "required": ["action"],
    },
}


def _path() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "vyrse" / "routines.json"


def load() -> Dict[str, str]:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
        return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}
    except FileNotFoundError:
        return dict(STARTERS)
    except (OSError, ValueError):
        return dict(STARTERS)


def _save(routines: Dict[str, str]) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(routines, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def _name(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s'-]", "", str(text or "").lower())).strip()[:32]


def match(message: str) -> Optional[tuple]:
    """A routine the message asks for: just its name ('study mode', 'bedtime pls', 'VYRSE, gaming mode') or a command
    to start it ('start / run / switch to / time for movie night'). A name merely mentioned ('what's a good bedtime?')
    doesn't count."""
    text = re.sub(r"[^\w\s'-]", " ", message.lower())
    text = re.sub(r"\b(?:vyrse|vyse|hey|ok|okay|please|pls|plz|now|on|mode on|thanks)\b", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    routines = load()
    for name in sorted(routines, key=len, reverse=True):
        lead = r"(?:(?:start|run|do|begin|activate|enable|turn on|switch to|go|time for|it'?s|its|lets do|let'?s do|let'?s go)\s+)?"
        if re.fullmatch(lead + re.escape(name) + r"(?:\s+(?:time|mode))?", text):
            return name, routines[name]
    return None


def handle(params: Dict[str, Any], **_: Any) -> str:
    action = params.get("action")
    with _LOCK:
        routines = load()
        if action == "list":
            return json.dumps({"ok": True, "routines": routines}, ensure_ascii=False)
        name = _name(params.get("name", ""))
        if len(name) < 3:
            return json.dumps({"ok": False, "error": "Give the routine a name (the phrase that runs it)."})
        if action == "delete":
            if name not in routines:
                return json.dumps({"ok": False, "error": f"No routine called {name}."})
            routines.pop(name)
            _save(routines)
            return json.dumps({"ok": True, "deleted": name})
        if action == "create":
            steps = re.sub(r"\s+", " ", str(params.get("steps") or "")).strip()[:700]
            if len(steps) < 10:
                return json.dumps({"ok": False, "error": "Write the steps (what to do, in order)."})
            if name not in routines and len(routines) >= MAX:
                return json.dumps({"ok": False, "error": f"There are already {MAX} routines; delete one first."})
            routines[name] = steps
            _save(routines)
            return json.dumps({"ok": True, "saved": name, "note": f"Saying “{name}” runs it from now on. Confirm in one line."})
    return json.dumps({"ok": False, "error": f"unknown action {action!r}"})


def hint(message: str) -> List[str]:
    found = match(message)
    if not found:
        return []
    name, steps = found
    return [f"The user said their “{name}” routine: do these steps now with your tools, then confirm in one line: {steps}"]
