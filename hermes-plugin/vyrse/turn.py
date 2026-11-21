"""What the user actually said this turn (their own words, not a nudge Hermes adds mid-turn).

Tools use it to check that the model is doing what was asked: captions only when asked for, a reminder repeats
only when the user asked for a repeat, on-screen help gets the right hint.

It is kept per conversation. It used to be one value for the whole plugin, and VYRSE's hidden warm-up chat
("Reply with exactly: ready", sent as the app starts) could overwrite the user's first message: on 2026-11-17
"set an alarm for 2:21 AM", sent right after launch, was saved as a plain reminder because the tool no longer saw
the word "alarm".
"""
from __future__ import annotations

from typing import Any, Dict

WARMUP_PROMPT = "Reply with exactly: ready"
_KEEP = 40

_last_user = ""
_by_session: Dict[str, str] = {}


def pre_llm_call(platform: str = "", user_message: Any = "", session_id: str = "", **_: Any) -> None:
    global _last_user
    text = str(user_message or "")
    if platform != "vyrse" or not text.strip() or text.lstrip().startswith(("[System:", "[IMPORTANT:")):
        return None
    if text.strip() == WARMUP_PROMPT:
        return None
    _last_user = text[:2000]
    if session_id:
        _by_session.pop(session_id, None)
        _by_session[session_id] = _last_user
        while len(_by_session) > _KEEP:
            _by_session.pop(next(iter(_by_session)))
    return None


def _current_session() -> str:
    try:
        from gateway.session_context import get_session_env

        return str(get_session_env("HERMES_SESSION_ID", "") or "")
    except Exception:
        return ""


def said() -> str:
    """The user's words in the conversation this tool call belongs to (the latest message anywhere if unknown)."""
    session = _current_session()
    if session and session in _by_session:
        return _by_session[session]
    return _last_user


def set_said(text: str) -> None:  # tests
    global _last_user
    _last_user = text
    _by_session.clear()
