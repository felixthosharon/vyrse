"""Ask the VYRSE desktop app to do something only it can (e.g. Alexa, which lives in the Electron main
process) and wait for the result. Same round trip as confirm.py: a `vyrse.ui` {action: "desktop_call"}
event goes to the window, which runs it and posts the result to /api/plugins/vyrse/desktop-result/<id>.
"""
from __future__ import annotations

import threading
import uuid
from typing import Any, Dict, Optional

_pending: Dict[str, dict] = {}
_lock = threading.Lock()


def call(target: str, op: str, args: Optional[Dict[str, Any]] = None, timeout: float = 30.0) -> Dict[str, Any]:
    from tools import desktop_ui

    cid = uuid.uuid4().hex[:12]
    entry: Dict[str, Any] = {"event": threading.Event(), "result": None}
    with _lock:
        _pending[cid] = entry
    try:
        payload = {"action": "desktop_call", "id": cid, "target": target, "op": op, "args": args or {}}
        if not desktop_ui.emit("vyrse.ui", payload):
            return {"ok": False, "error": "The VYRSE window isn't connected."}
        if not entry["event"].wait(timeout):
            return {"ok": False, "error": "The VYRSE app didn't answer in time."}
        result = entry["result"]
        return result if isinstance(result, dict) else {"ok": False, "error": "Bad answer from the VYRSE app."}
    finally:
        with _lock:
            _pending.pop(cid, None)


def deliver(cid: str, result: Any) -> bool:
    with _lock:
        entry = _pending.get(cid)
    if entry is None:
        return False
    entry["result"] = result
    entry["event"].set()
    return True
