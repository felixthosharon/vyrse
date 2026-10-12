"""The `vyrse_ui` tool: Hermes controls the VYRSE interface through explicit actions.

Each action is validated here and delivered to the VYRSE window as a `vyrse.ui` event, where
the frontend runs it through the same functions a human click would. No DOM access.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict

from . import ui_state

PANELS = ("settings", "history", "transcript", "none")
MODES = ui_state.CHOICES["mode"]
REASONING = ("none", "low", "medium", "high")

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_ui",
    "description": (
        "Control the VYRSE desktop interface the user is looking at. Use it when the user asks to change how "
        "VYRSE looks or behaves, or to show something in it. Actions: get_state (current interface "
        "preferences); set (change preferences, e.g. theme); open (show the settings, history or transcript "
        "panel, or 'none' to close panels); new_conversation; open_conversation (by words from its title); "
        "set_mode (assistant, private = local model only, gaming = unload the local model to free the GPU); "
        "set_model (switch the AI model; takes effect after this reply); set_reasoning; notify (short "
        "on-screen message)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["get_state", "set", "open", "new_conversation", "open_conversation",
                         "set_mode", "set_model", "set_reasoning", "notify"],
            },
            "preferences": {
                "type": "object",
                "description": "For action=set. Any of: theme (system|dark|light), density (comfortable|compact), "
                               "animations (full|reduced|off), presenceIntensity (subtle|balanced|expressive), "
                               "idleActivity (minimal|normal|lively), textSize (0.9-1.25), voiceResponses (bool), "
                               "volume (0-1), voiceResponses (bool: speak replies), speakTyped (bool: speak replies to "
                               "typed messages too), highContrast (bool), reducedMotion (bool), talkStyle (how you talk: "
                               "normal|vibe|fam|chill|hype|focus|pro|savage; e.g. 'switch to fam mode' -> talkStyle fam, "
                               "'vibe mode off' -> normal).",
            },
            "panel": {"type": "string", "enum": list(PANELS), "description": "For action=open."},
            "query": {"type": "string", "description": "For action=open_conversation: words from its title."},
            "mode": {"type": "string", "enum": list(MODES), "description": "For action=set_mode."},
            "model": {"type": "string", "description": "REQUIRED for action=set_model: the model's name or part of it, "
                                                     "e.g. 'gemma' or 'qwen' (models on this PC)."},
            "provider": {"type": "string", "description": "For action=set_model: leave empty for models on this PC."},
            "level": {"type": "string", "enum": list(REASONING), "description": "For action=set_reasoning."},
            "text": {"type": "string", "description": "For action=notify: one short sentence."},
        },
        "required": ["action"],
    },
}


def _ok(**data: Any) -> str:
    return json.dumps({"success": True, **data})


def _err(message: str) -> str:
    return json.dumps({"success": False, "error": message})


def _in_vyrse_session() -> bool:
    from gateway.session_context import get_session_env
    values = {get_session_env(k, "") for k in ("HERMES_SESSION_PLATFORM", "HERMES_SESSION_SOURCE")}
    return "vyrse" in values


def _emit(payload: Dict[str, Any]) -> bool:
    from tools import desktop_ui
    return desktop_ui.emit("vyrse.ui", payload)


def handle(params: Dict[str, Any], **_: Any) -> str:
    if not _in_vyrse_session():
        return _err("vyrse_ui only works in conversations held in the VYRSE desktop app.")
    action = params.get("action")
    handler = _ACTIONS.get(str(action))
    if handler is None:
        return _err(f"unknown action {action!r}")
    try:
        return handler(params)
    except Exception as exc:  # never crash the agent loop over a UI request
        return _err(f"VYRSE could not do that: {exc}")


def _deliver(payload: Dict[str, Any], done: str) -> str:
    if not _emit(payload):
        return _err("The VYRSE window is not connected right now.")
    return _ok(result=done)


def _get_state(_: Dict[str, Any]) -> str:
    return _ok(preferences=ui_state.load(), options={k: list(v) for k, v in ui_state.CHOICES.items()})


def _set(params: Dict[str, Any]) -> str:
    patch = params.get("preferences")
    if not isinstance(patch, dict) or not patch:
        return _err("action=set needs a non-empty 'preferences' object")
    prefs, errors = ui_state.update(patch)
    accepted = {k: prefs[k] for k in patch if k in prefs and k not in errors}
    if not accepted:
        return _err(f"no valid preferences: {errors}")
    if not _emit({"action": "prefs", "prefs": accepted}):
        return _err("Saved, but the VYRSE window is not connected right now.")
    return _ok(applied=accepted, rejected=errors or None)


def _open(params: Dict[str, Any]) -> str:
    panel = params.get("panel")
    if panel not in PANELS:
        return _err(f"panel must be one of {', '.join(PANELS)}")
    return _deliver({"action": "open", "panel": panel}, f"opened {panel}" if panel != "none" else "closed panels")


def _new_conversation(_: Dict[str, Any]) -> str:
    return _deliver({"action": "new_conversation"}, "VYRSE will start a new conversation after this reply")


def _open_conversation(params: Dict[str, Any]) -> str:
    query = str(params.get("query") or "").strip()
    if not query:
        return _err("action=open_conversation needs 'query'")
    return _deliver({"action": "open_conversation", "query": query[:120]},
                    f"VYRSE will open the conversation best matching {query!r} after this reply")


def _set_mode(params: Dict[str, Any]) -> str:
    mode = params.get("mode")
    if mode not in MODES:
        return _err(f"mode must be one of {', '.join(MODES)}")
    ui_state.update({"mode": mode})
    return _deliver({"action": "mode", "mode": mode}, f"mode set to {mode}")


def _set_model(params: Dict[str, Any]) -> str:
    model = str(params.get("model") or "").strip()
    if not model:
        return _err("action=set_model needs 'model', e.g. model='gemma' or model='qwen'")
    return _deliver({"action": "model", "model": model, "provider": str(params.get("provider") or "")},
                    f"VYRSE will switch to {model} (applies from the next message)")


def _set_reasoning(params: Dict[str, Any]) -> str:
    level = params.get("level")
    if level not in REASONING:
        return _err(f"level must be one of {', '.join(REASONING)}")
    return _deliver({"action": "reasoning", "level": level}, f"reasoning set to {level}")


def _notify(params: Dict[str, Any]) -> str:
    text = str(params.get("text") or "").strip()
    if not text:
        return _err("action=notify needs 'text'")
    return _deliver({"action": "notify", "text": text[:200]}, "shown")


_ACTIONS: Dict[str, Callable[[Dict[str, Any]], str]] = {
    "get_state": _get_state,
    "set": _set,
    "open": _open,
    "new_conversation": _new_conversation,
    "open_conversation": _open_conversation,
    "set_mode": _set_mode,
    "set_model": _set_model,
    "set_reasoning": _set_reasoning,
    "notify": _notify,
}
