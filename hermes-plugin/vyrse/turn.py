"""What the user actually said this turn (their own words, not a nudge Hermes adds mid-turn).

Tools use it to check that the model is doing what was asked: captions only when asked for, a reminder repeats
only when the user asked for a repeat, on-screen help gets the right hint.
"""
from __future__ import annotations

from typing import Any

_last_user = ""


def pre_llm_call(platform: str = "", user_message: Any = "", **_: Any) -> None:
    global _last_user
    text = str(user_message or "")
    if platform == "vyrse" and text.strip() and not text.lstrip().startswith(("[System:", "[IMPORTANT:")):
        _last_user = text[:2000]
    return None


def said() -> str:
    return _last_user


def set_said(text: str) -> None:  # tests
    global _last_user
    _last_user = text
