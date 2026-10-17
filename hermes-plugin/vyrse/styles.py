"""Talk styles the user makes ("talk like my best friend: short, roasts me, says bro"). Stored next to the UI
state; they sit beside the built-in styles in the picker and work exactly like them (only tone and wording change,
never what VYRSE does).
"""
from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from typing import Any, Dict, List

MAX = 8
_LOCK = threading.Lock()

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_style",
    "description": (
        "Talk styles the user designs ('make a talk style that…', 'talk like my best friend', 'delete my X style'). "
        "action=create: name (one or two words) + prompt (YOU write it from what they described: second person, how to "
        "talk: tone, length, words to use or avoid, how much humour; 2-5 sentences) + hint (a few words for the picker). "
        "It becomes the active style: reply with one short line in it as a preview. action=delete (name), list."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["create", "delete", "list"]},
            "name": {"type": "string"},
            "prompt": {"type": "string", "description": "For create: the style instructions."},
            "hint": {"type": "string", "description": "For create: a few words shown in the picker."},
        },
        "required": ["action"],
    },
}


def _path() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "vyrse" / "styles.json"


def load() -> Dict[str, Dict[str, str]]:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
        return {k: v for k, v in data.items() if k.startswith("custom:") and isinstance(v, dict)}
    except (OSError, ValueError):
        return {}


def _save(styles: Dict[str, Dict[str, str]]) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(styles, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def listing() -> List[Dict[str, str]]:
    return [{"id": k, "label": v["label"], "hint": v.get("hint", "")} for k, v in load().items()]


def _slug(name: str) -> str:
    return "custom:" + (re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24] or "style")


def _clean(text: str, limit: int) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()[:limit]


def _announce(active: str) -> None:
    """Tell the VYRSE window: the new list, and the style now in use."""
    try:
        from tools import desktop_ui

        desktop_ui.emit("vyrse.ui", {"action": "prefs", "prefs": {"talkStyle": active, "customStyles": listing()}})
    except Exception:
        pass


def handle(params: Dict[str, Any], **_: Any) -> str:
    from . import ui_state

    action = params.get("action")
    if action == "list":
        return json.dumps({"ok": True, "styles": listing()})
    name = _clean(params.get("name", ""), 24)
    if not name:
        return json.dumps({"ok": False, "error": "Give the style a name."})
    sid = _slug(name)
    with _LOCK:
        styles = load()
        if action == "delete":
            if sid not in styles:
                return json.dumps({"ok": False, "error": f"No style called {name}."})
            was_active = ui_state.load().get("talkStyle") == sid
            styles.pop(sid)
            _save(styles)
            if was_active:
                ui_state.update({"talkStyle": "normal"})
            _announce(ui_state.load().get("talkStyle", "normal"))
            return json.dumps({"ok": True, "deleted": name})
        if action != "create":
            return json.dumps({"ok": False, "error": f"unknown action {action!r}"})
        prompt = _clean(params.get("prompt", ""), 900)
        if len(prompt) < 20:
            return json.dumps({"ok": False, "error": "Write the style's instructions in prompt (2-5 sentences)."})
        if sid not in styles and len(styles) >= MAX:
            return json.dumps({"ok": False, "error": f"There are already {MAX} custom styles; delete one first."})
        styles[sid] = {"label": name[:1].upper() + name[1:], "prompt": prompt, "hint": _clean(params.get("hint", ""), 48)}
        _save(styles)
    ui_state.update({"talkStyle": sid})
    _announce(sid)
    return json.dumps({"ok": True, "created": name, "active": True,
                       "note": "It's the active style now (and in the picker). Reply with one short line in it as a preview."})
