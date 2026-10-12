"""Ask the user a yes/no question in the VYRSE window and wait for the answer (plugin tools only).

The question is delivered as a `vyrse.ui` {action: "confirm"} event; VYRSE shows it as a card and posts the
answer to /api/plugins/vyrse/confirm/<id>, which calls `answer()`. No answer within the timeout = no.
"""
from __future__ import annotations

import threading
import uuid
from typing import Dict, List, Optional

_pending: Dict[str, dict] = {}
_lock = threading.Lock()


def ask(question: str, choices: List[str], timeout: float = 180.0) -> Optional[str]:
    """Returns the chosen label, or None if VYRSE isn't connected, the user declined, or time ran out."""
    from tools import desktop_ui

    qid = uuid.uuid4().hex[:12]
    entry = {"event": threading.Event(), "answer": None}
    with _lock:
        _pending[qid] = entry
    try:
        if not desktop_ui.emit("vyrse.ui", {"action": "confirm", "id": qid, "question": question, "choices": choices}):
            return None
        entry["event"].wait(timeout)
        return entry["answer"]
    finally:
        with _lock:
            _pending.pop(qid, None)


def answer(qid: str, choice: Optional[str]) -> bool:
    with _lock:
        entry = _pending.get(qid)
    if entry is None:
        return False
    entry["answer"] = choice
    entry["event"].set()
    return True
