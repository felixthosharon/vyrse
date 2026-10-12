"""Private mode: nothing leaves the PC. A `pre_tool_call` hook vetoes online tools in VYRSE sessions while
VYRSE's mode is "private" (the app already keeps to local models in that mode)."""
from __future__ import annotations

from typing import Any, Dict, Optional

_ONLINE_TOOLS = {"web_search", "web_extract", "vyrse_skills", "vyrse_alexa"}


def is_online(tool_name: str, args: Optional[Dict[str, Any]]) -> bool:
    if tool_name in _ONLINE_TOOLS or tool_name.startswith("browser"):
        return True
    # Workspace images fetched from the web.
    return tool_name == "vyrse_workspace" and bool((args or {}).get("url"))


def guard(tool_name: str = "", args: Optional[Dict[str, Any]] = None, **_: Any) -> Optional[Dict[str, str]]:
    if not is_online(tool_name, args):
        return None
    try:
        from .tools import _in_vyrse_session
        from . import ui_state

        if not _in_vyrse_session() or ui_state.load().get("mode") != "private":
            return None
    except Exception:
        return None
    return {
        "action": "block",
        "message": (
            f"{tool_name} is blocked: VYRSE is in Private mode, so nothing goes online. Answer from what's on "
            "this PC, or tell the user to switch to Assistant mode for web access."
        ),
    }
