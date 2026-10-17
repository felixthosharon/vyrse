"""`vyrse_profile`: the "get to know you" setup. VYRSE interviews the user (one question at a time, the
vyrse-setup skill), notes each answer here, and on a yes writes an "About <name>" section into SOUL.md.

The preset personality in SOUL.md is never touched: the section lives between two markers at the end and is
replaced as a whole when the setup is run again. The default talk style stays as it is; the section only adds
what this user needs on top.
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

START = "<!-- vyrse:profile:start -->"
END = "<!-- vyrse:profile:end -->"
_LOCK = threading.Lock()

# what the interview covers, in order; label and card icon for each
FIELDS: Dict[str, tuple] = {
    "role": ("Who they are", "user"),
    "uses": ("What VYRSE is for", "idea"),
    "day": ("Their day", "clock"),
    "apps": ("Apps & games", "game"),
    "answers": ("How to answer", "chart"),
    "interests": ("Into", "heart"),
    "city": ("City", "map"),
    "never": ("Never do", "alert"),
}

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_profile",
    "description": (
        "The personal setup ('let's set you up', 'get to know me', 'redo my profile'). Load the vyrse-setup skill first "
        "and follow it. action=start (begin a fresh setup; shows the card), note (field + value after EACH answer: a "
        "short, plain summary of what they said), save (when all is asked: shows the summary and asks the user to "
        "confirm, then writes it into your personality), show (what's saved now)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["start", "note", "save", "show"]},
            "field": {"type": "string", "enum": list(FIELDS)},
            "value": {"type": "string", "description": "For note: what they said, summarised in a short line (their words where possible)."},
        },
        "required": ["action"],
    },
}


def _home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path(os.environ.get("LOCALAPPDATA", Path.home())) / "hermes")


def _draft_path() -> Path:
    d = _home() / "vyrse"
    d.mkdir(parents=True, exist_ok=True)
    return d / "profile_draft.json"


def _load_draft() -> Dict[str, str]:
    try:
        return json.loads(_draft_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_draft(d: Dict[str, str]) -> None:
    _draft_path().write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")


def _clean(text: str, limit: int = 240) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    # it ends up in the system prompt: no markers, no headings that could pose as instructions
    text = text.replace(START, "").replace(END, "").replace("#", "")
    return text[:limit]


def _name() -> str:
    try:
        from . import ui_state

        return ui_state.load().get("userName") or "the user"
    except Exception:
        return "the user"


def card(draft: Dict[str, str]) -> Dict[str, Any]:
    """The live 'Getting to know you' card: one tile per answer so far."""
    items = [{"label": FIELDS[k][0], "detail": draft[k], "icon": FIELDS[k][1]} for k in FIELDS if draft.get(k)]
    done = len(items)
    return {"kind": "cards", "id": "vyrse-profile", "title": f"Getting to know {_name()}",
            "items": items or [{"label": "Starting", "detail": "A few quick questions, then I'm set up for you.", "icon": "user"}],
            "caption": f"{done} of {len(FIELDS)}"}


def _show(draft: Dict[str, str]) -> None:
    from .workspace import build_artifact, deliver

    try:
        deliver({"action": "workspace", "op": "show", "artifact": build_artifact(card(draft))})
    except Exception:
        pass


def section(draft: Dict[str, str]) -> str:
    """The text written into SOUL.md."""
    name = _name()
    lines = [f"## About {name} (from their setup)",
             f"What {name} told VYRSE when setting it up. Use it to fit help to them; it adds to everything above "
             "and changes nothing about who VYRSE is or the talk style they pick."]
    for k, (label, _) in FIELDS.items():
        if draft.get(k):
            lines.append(f"- {label}: {draft[k]}")
    return "\n".join(lines)


def soul_path() -> Path:
    return _home() / "SOUL.md"


def write_section(text: str) -> None:
    """Put the section between the markers (replacing an older one), leaving the rest of SOUL.md as it is."""
    p = soul_path()
    with _LOCK:
        soul = p.read_text(encoding="utf-8") if p.exists() else ""
        block = f"{START}\n{text}\n{END}"
        if START in soul and END in soul:
            soul = soul[: soul.index(START)] + block + soul[soul.index(END) + len(END):]
        else:
            soul = soul.rstrip() + "\n\n" + block + "\n"
        tmp = p.with_suffix(".tmp")
        tmp.write_text(soul, encoding="utf-8")
        os.replace(tmp, p)


def read_section() -> Optional[str]:
    p = soul_path()
    if not p.exists():
        return None
    soul = p.read_text(encoding="utf-8")
    if START in soul and END in soul:
        return soul[soul.index(START) + len(START): soul.index(END)].strip()
    return None


def _apply_prefs(draft: Dict[str, str]) -> List[str]:
    """Fill VYRSE settings the answers make obvious (briefing games); returns what changed."""
    changed: List[str] = []
    apps = draft.get("apps") or ""
    if apps:
        try:
            from . import ui_state

            if not ui_state.load().get("briefingGames"):
                games = [g.strip() for g in re.split(r",|/| and ", apps) if g.strip()][:5]
                ui_state.update({"briefingGames": ", ".join(games)})
                changed.append("briefing topics")
        except Exception:
            pass
    return changed


def handle(params: Dict[str, Any], **_: Any) -> str:
    action = params.get("action")
    if action == "start":
        _save_draft({})
        _show({})
        return json.dumps({"ok": True, "note": "Fresh setup started; the card is on screen. Ask the first question (who they are / what they do)."})
    if action == "note":
        field = params.get("field")
        if field not in FIELDS:
            return json.dumps({"ok": False, "error": f"field must be one of {', '.join(FIELDS)}"})
        value = _clean(params.get("value", ""))
        if not value:
            return json.dumps({"ok": False, "error": "value is empty"})
        draft = _load_draft()
        draft[field] = value
        _save_draft(draft)
        _show(draft)
        left = [k for k in FIELDS if not draft.get(k)]
        return json.dumps({"ok": True, "noted": field, "still_to_ask": left,
                           "note": "Noted on the card. Ask the next one in a sentence (or save if none are left)."})
    if action == "save":
        draft = _load_draft()
        if not draft:
            return json.dumps({"ok": False, "error": "Nothing noted yet."})
        text = section(draft)
        from . import confirm

        choice = confirm.ask("Here's what I'll remember about you:\n\n" + "\n".join(text.splitlines()[2:]) + "\n\nSave it?", ["Save it", "Not yet"])
        if choice is None:
            return json.dumps({"ok": False, "summary": text, "note": "Couldn't ask in the window. Read the summary out and ask them to say yes; then call save again."})
        if choice != "Save it":
            return json.dumps({"ok": True, "saved": False, "note": "They want changes. Ask what to fix, note it again, then save."})
        write_section(text)
        changed = _apply_prefs(draft)
        return json.dumps({"ok": True, "saved": True, "settings_filled": changed,
                           "note": "Saved into your personality (it applies from the next conversation). Also save 3-5 of the most "
                                   "useful facts with the memory tool. Then thank them in one or two sentences and suggest one "
                                   "thing to try based on what they said."})
    if action == "show":
        return json.dumps({"ok": True, "profile": read_section() or "No setup saved yet."})
    return json.dumps({"ok": False, "error": f"unknown action {action!r}"})
