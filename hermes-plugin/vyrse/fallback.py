"""No silent replies. Small local models often end a turn right after a VYRSE tool (a card shown, a quiz answer
recorded) without writing anything; Hermes then puts "the turn stopped while a tool result was still pending…
send `continue`" in its place. Instead, VYRSE answers with the line that fits what just happened: "It's on your
board.", or the quiz's verdict and next question.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, Optional

_last: Dict[str, str] = {}  # session -> what to say if the model says nothing

_STOPPED = re.compile(r"tool result was still pending|stopped while a tool|send `?continue`?|^no reply\b", re.I)
# The model's notes to itself. When it ends a turn with only its thinking, Hermes returns that as the answer and
# the app strips these sentences (app/src/services/hermes/turns.ts SELF_TALK), leaving an empty bubble.
_SELF_TALK = re.compile(
    r"^(?:I should|I need to|I must|I'll (?:now )?(?:respond|reply|answer|mention|keep|make sure|provide|give|call|use|try)|"
    r"Let me (?:respond|reply|answer|think|check|keep|provide|give|call|use|try)|The user (?:is|wants|asked|said|has|just)|"
    r"\w+ (?:is asking|wants me|asked me)|Now I|My (?:reply|response|answer) (?:should|will)|Okay,? (?:so|the user)|So the user)", re.I)


def is_self_talk(text: str) -> bool:
    """Empty, or mostly sentences the model wrote to itself."""
    sentences = [s.strip() for s in re.findall(r"[^.!?\n]+[.!?]*", text or "") if s.strip()]
    if not sentences:
        return True
    return sum(bool(_SELF_TALK.match(s)) for s in sentences) * 2 >= len(sentences)


def line_for(tool: str, result: Any) -> Optional[str]:
    """What VYRSE should say after this tool, if the model doesn't say anything."""
    text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False) if result is not None else ""
    try:
        data = json.loads(text) if text.strip().startswith("{") else {}
    except ValueError:
        data = {}
    if data.get("success") is False or data.get("ok") is False:
        return None
    body = str(data.get("result") or data.get("note") or text)
    if tool == "vyrse_quiz":
        verdict = ""
        m = re.search(r"Recorded question \d+ as (right|wrong)\.(?: The expected answer was: (.+?)\.)?", body)
        if m:
            verdict = "Right! " if m.group(1) == "right" else (f"Not quite: it's {m.group(2)}. " if m.group(2) else "Not quite. ")
        q = re.search(r"question (\d+): \\?\"(.+?)\\?\"", body)
        if q:
            return f"{verdict}Question {q.group(1)}: {q.group(2)}".strip()
        s = re.search(r"Quiz over: (\d+/\d+)", body)
        if s:
            return f"{verdict}That's the quiz: {s.group(1)}. Your scorecard's on the board.".strip()
        return verdict.strip() or None
    if tool == "vyrse_workspace":
        m = re.search(r"showing '(.+?)' in the workspace", body)
        return f"Here you go: {m.group(1)} is on your board." if m else "It's on your board."
    if tool in ("vyrse_point",):
        if data.get("first"):
            return f"Step 1: {data['first']}. It's ringed on your screen; I'll ring the next one after you click."
        if data.get("done") and data.get("reached"):
            return "Done, you're there."
        return "Right there, it's ringed on your screen."
    if tool == "vyrse_screen" and data.get("saved"):
        return f"Screenshot saved to {data['saved']}."
    if tool == "vyrse_desktop":
        if data.get("arranged"):
            places = ", ".join(str(a).replace(": ", " ") for a in data["arranged"][:6])
            return f"Tidied: {places}."
        if data.get("now") and data.get("window"):
            return f"Done: {data['window'][:60]} is {data['now']}."
        if data.get("windows") is not None:
            return None
        return "Done."
    if tool in ("vyrse_captions", "vyrse_focus", "vyrse_routine", "vyrse_notes"):
        note = str(data.get("note") or "")
        return note.split(". Reply")[0].rstrip(".") + "." if note else "Done."
    if tool.startswith("vyrse_"):
        return "Done. It's on your screen."
    return None


def post_tool_call(tool_name: str = "", result: Any = None, session_id: str = "", **_: Any) -> None:
    if not session_id or not str(tool_name).startswith("vyrse_"):
        return
    line = line_for(tool_name, result)
    if line:
        _last[session_id] = line[:300]
    else:
        _last.pop(session_id, None)


def pre_llm_call(session_id: str = "", **_: Any) -> None:
    """A new user message: forget the last turn's line."""
    _last.pop(session_id, None)
    return None


def transform_llm_output(response_text: str = "", session_id: str = "", platform: str = "", **_: Any) -> Optional[str]:
    if platform != "vyrse" or not session_id:
        return None
    line = _last.pop(session_id, None)
    if line and len(response_text or "") < 1200 and (_STOPPED.search(response_text or "") or is_self_talk(response_text)):
        return line
    return None
