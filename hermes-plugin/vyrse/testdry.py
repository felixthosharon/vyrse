"""Test runs that can't touch the user's PC: with VYRSE_TEST_DRY=1 (set only by the smoke battery), every tool call
that would change something (move or close windows, click, type, open tabs or apps, change volume, send to the
phone or the Echo, set reminders, save memories, change VYRSE's settings) is answered with "done (test run)"
instead of running. Reading tools (screen, files, system info, digest, captions text) still run for real, so the
test shows what the model chose and what it would have done.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

# tool -> the actions that only read (None = every action changes something)
_READ_ONLY: Dict[str, Optional[tuple]] = {
    "vyrse_desktop": ("windows", "read"),
    "vyrse_chrome": ("tabs", "read", "look"),
    "vyrse_controls": ("now_playing", "clipboard_get", "clipboard_history"),
    "vyrse_files": ("find",),
    "vyrse_reminders": ("list",),
    "vyrse_routine": ("list",),
    "vyrse_alexa": ("devices",),
    "vyrse_ui": ("get_state",),
    "vyrse_phone": None,
    "vyrse_profile": ("start", "show"),
    "vyrse_log": ("show", "list"),
    "vyrse_style": ("list",),
    "vyrse_point": None,
    "memory": None,
    "cronjob": ("list",),
    "computer_use": None,
    "send_message": None,
    # Hermes' own tools that can change things: in a test, record that the model reached for them, run nothing
    "terminal": None,
    "execute_code": None,
    "process": None,
    "write_file": None,
    "patch": None,
    "skill_manage": None,
}
_BROWSER = ("browser_",)


def pre_tool_call(tool_name: str = "", args: Optional[Dict[str, Any]] = None, **_: Any) -> Optional[Dict[str, Any]]:
    if not os.environ.get("VYRSE_TEST_DRY"):
        return None
    args = args if isinstance(args, dict) else {}
    if tool_name in os.environ.get("VYRSE_TEST_ALLOW", "").split(","):
        return None  # this test exercises that tool for real (and cleans up after itself)
    action = str(args.get("action") or "")
    if tool_name in _READ_ONLY:
        allowed = _READ_ONLY[tool_name]
        if allowed is not None and action in allowed:
            return None
    elif not tool_name.startswith(_BROWSER):
        return None
    return {"action": "block", "message": json.dumps({
        "ok": True, "success": True, "dry_run": True, "would": {"tool": tool_name, **args},
        "note": "Done (test run: nothing on the PC was changed). Reply to the user as if it worked."})}
