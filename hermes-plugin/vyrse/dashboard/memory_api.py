"""What VYRSE remembers, for the Settings page: list Hermes' built-in memory notes, and add, edit or delete one.

Hermes keeps two small note files (things about the world and the PC, and things about the user). They are read
and written through Hermes' own MemoryStore, so the same limits, locking and safety checks apply as when the
agent saves a note itself. A change shows up in the next conversation (a running one keeps the notes it started
with).
"""
from __future__ import annotations

from typing import Any, Dict, List

TARGETS = ("user", "memory")
MAX_NOTE_CHARS = 600


def _store():
    from tools.memory_tool import load_on_disk_store

    return load_on_disk_store()


def _view(store) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for target in TARGETS:
        entries: List[str] = list(store._entries_for(target))
        out[target] = {"entries": entries, "used": store._char_count(target), "limit": store._char_limit(target)}
    return out


def listing() -> Dict[str, Any]:
    return _view(_store())


def _result(store, response: Dict[str, Any]) -> Dict[str, Any]:
    ok = bool(response.get("success"))
    message = str(response.get("error") or response.get("message") or "")
    if not ok and "would exceed the limit" in message:
        message = "Memory is full. Delete or shorten a note first."
    return {"ok": ok, "message": message, "memory": _view(_store() if ok else store)}


def _check(target: str, text: str = "x") -> str:
    if target not in TARGETS:
        return "Unknown kind of note."
    if not text.strip():
        return "A note can't be empty."
    if len(text) > MAX_NOTE_CHARS:
        return f"Keep a note under {MAX_NOTE_CHARS} characters."
    if "§" in text:
        return "A note can't contain the § sign."
    return ""


def add(target: str, content: str) -> Dict[str, Any]:
    store = _store()
    if problem := _check(target, content):
        return {"ok": False, "message": problem, "memory": _view(store)}
    return _result(store, store.add(target, content))


def replace(target: str, entry: str, content: str) -> Dict[str, Any]:
    store = _store()
    if problem := _check(target, content):
        return {"ok": False, "message": problem, "memory": _view(store)}
    if entry not in store._entries_for(target):
        return {"ok": False, "message": "That note changed in the meantime. Try again.", "memory": _view(store)}
    return _result(store, store.replace(target, entry, content, matched_entry=entry))


def remove(target: str, entry: str) -> Dict[str, Any]:
    store = _store()
    if problem := _check(target):
        return {"ok": False, "message": problem, "memory": _view(store)}
    if entry not in store._entries_for(target):
        return {"ok": True, "message": "", "memory": _view(store)}  # already gone
    return _result(store, store.remove(target, entry, matched_entry=entry))
