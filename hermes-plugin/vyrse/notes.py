"""Lecture and meeting notes: a recording (made in VYRSE with "record this lecture", or any audio/video file) is
transcribed on this PC with Hermes' local Whisper, then VYRSE turns it into a summary, flashcards and a quiz.

Recordings and transcripts stay in %HERMES_HOME%/vyrse/recordings.
"""
from __future__ import annotations

import base64
import json
import re
import time
from pathlib import Path
from typing import Any, Dict, Optional

MAX_UPLOAD = 300 * 1024 * 1024
AUDIO = {".webm", ".ogg", ".opus", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".mp4", ".mkv", ".mov", ".wma"}

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_notes",
    "description": (
        "Lecture/meeting notes from a recording. action=transcribe: path (an audio or video file) or 'latest' (the last "
        "recording made in VYRSE). It transcribes on this PC, then YOU make: a summary in the workspace (kind=markdown: "
        "key points as short bullets, terms in bold), flashcards (kind=flashcards, the 8-15 most testable facts), and offer "
        "a quiz (vyrse_quiz). action=record starts recording in VYRSE ('record this lecture/class/meeting'); action=stop ends it."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["transcribe", "record", "stop"]},
            "path": {"type": "string", "description": "For transcribe: the file, or 'latest'."},
            "title": {"type": "string", "description": "For record: what it is (e.g. 'Physics lecture')."},
        },
        "required": ["action"],
    },
}


def folder() -> Path:
    from hermes_constants import get_hermes_home

    d = Path(get_hermes_home()) / "vyrse" / "recordings"
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_upload(data: bytes, title: str = "", ext: str = ".webm") -> Dict[str, Any]:
    """A recording made in VYRSE, sent by the app when the user stops it."""
    if not data or len(data) > MAX_UPLOAD:
        return {"ok": False, "error": "The recording is empty or too large."}
    ext = ext if ext in AUDIO else ".webm"
    name = time.strftime("%Y-%m-%d %H-%M") + (" " + re.sub(r"[^\w\- ]+", "", title)[:40].strip() if title else "")
    path = folder() / f"{name}{ext}"
    path.write_bytes(data)
    return {"ok": True, "path": str(path), "mb": round(len(data) / 1048576, 1)}


def _latest() -> Optional[Path]:
    files = [p for p in folder().iterdir() if p.suffix.lower() in AUDIO]
    return max(files, key=lambda p: p.stat().st_mtime) if files else None


def _ui(op: str, title: str = "") -> bool:
    try:
        from tools import desktop_ui

        return bool(desktop_ui.emit("vyrse.ui", {"action": "record", "op": op, "title": title[:60]}))
    except Exception:
        return False


def handle(params: Dict[str, Any], **_: Any) -> str:
    action = params.get("action")
    if action in ("record", "stop"):
        if not _ui("start" if action == "record" else "stop", str(params.get("title") or "")):
            return json.dumps({"ok": False, "error": "Recording needs the VYRSE window open."})
        return json.dumps({"ok": True, "recording": action == "record",
                           "note": "Recording in VYRSE now (a Stop button is on screen; saying 'stop recording' works too). Reply in a few words."
                           if action == "record" else "Stopped; VYRSE will hand you the file to transcribe."})
    if action != "transcribe":
        return json.dumps({"ok": False, "error": f"unknown action {action!r}"})
    raw = str(params.get("path") or "latest").strip().strip('"')
    path = _latest() if raw.lower() == "latest" else Path(raw)
    if not path or not path.is_file():
        return json.dumps({"ok": False, "error": "No recording found." if raw.lower() == "latest" else f"No such file: {raw}"})
    if path.suffix.lower() not in AUDIO:
        return json.dumps({"ok": False, "error": f"{path.suffix} isn't an audio or video file."})
    from tools.transcription_tools import transcribe_audio

    started = time.time()
    result = transcribe_audio(str(path))
    text = (result.get("transcript") or result.get("text") or "").strip()
    if not result.get("success", bool(text)) or not text:
        return json.dumps({"ok": False, "error": result.get("error") or "Couldn't make out any speech in that recording."})
    path.with_suffix(".txt").write_text(text, encoding="utf-8")
    words = len(text.split())
    return json.dumps({"ok": True, "file": path.name, "words": words, "took_s": round(time.time() - started),
                       "transcript": text[:16000] + ("…(transcript continues; the full text is saved next to the recording)" if len(text) > 16000 else ""),
                       "note": ("Now, in this order: 1) vyrse_workspace show kind=markdown, title 'Notes: <topic>', the key points as "
                                "short bullets with terms in bold; 2) vyrse_workspace show kind=flashcards with the 8-15 most testable "
                                "facts. Both cards, every time. Then reply in two sentences and offer a quiz.")},
                      ensure_ascii=False)
