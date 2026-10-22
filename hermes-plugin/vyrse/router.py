"""Point a small model at the right tool for the everyday requests it gets wrong.

Found by testing the first things people ask (2026-10-22): the local model answered "what time is it" with a made-up
time, said "I've paused it" without touching the music, walked the whole disk for "find my resume" (four minutes,
nothing found) instead of the instant file index, answered "the latest iPhone price" from memory, and read
"yesterday afternoon" as "the last hour". Each turn gets the clock, and a request that matches one of these gets a
one-line hint naming the tool. It only adds context; the model still decides.
"""
from __future__ import annotations

import re
import time
from typing import Any, Dict, Optional

_MEDIA = re.compile(
    r"^(?:pause|play|resume|unpause|stop|skip|next|previous|prev|mute|unmute)\b(?:\s+(?:it|this|that|the (?:music|song|track|video)|music|spotify|song))?\W*$"
    r"|\b(?:pause|resume|unpause) (?:it|this|the music|music|spotify|the song|youtube)\b"
    r"|\b(?:next|previous|last) (?:song|track)\b|\bskip (?:this|the)? ?(?:song|track)\b|\bvolume\b"
    r"|\b(?:louder|quieter|softer|turn it (?:up|down)|turn (?:the )?(?:music|sound) (?:up|down))\b", re.I)
_FILES = re.compile(
    r"\b(?:find|where(?:'s| is| are| did i (?:put|save))|locate|look for|search for|open)\s+(?:my|the|that|a)\s+"
    r"(?:[\w'\-]+\s+){0,4}?(?:files?|docs?|documents?|resume|cv|pdfs?|essays?|assignments?|reports?|notes|"
    r"presentations?|slides|photos?|pictures?|pics|spreadsheets?|excel|word file|projects?|homework|downloads?|zip)\b", re.I)
_WEB = re.compile(
    r"\b(?:search (?:the )?(?:web|internet|online)|google (?:it|this|that|for)?|look (?:it |that |this )?up|"
    r"(?:latest|newest) (?!file|download)|news\b|headlines|price of|how much (?:is|are|does) (?:a |an |the )?(?!my)|"
    r"who won|score of|stock price|exchange rate|release date|is .{2,30} out yet)", re.I)
_SHOT = re.compile(r"\b(?:take|grab|save|get) (?:a |me a )?screen ?shot\b|^screen ?shot\W*$", re.I)
_EMAIL = re.compile(r"\b(?:write|draft|send|compose|type up) (?:an? |the )?(?:e-?mail|mail)\b", re.I)
_RECORD = re.compile(r"\brecord (?:this|the|my|a)? ?(?:lecture|class|lesson|meeting|talk|seminar|call)\b", re.I)
_WEATHER = re.compile(r"\b(?:weather|forecast|temperature outside|(?:will|is) it (?:going to )?(?:rain|be (?:hot|cold|sunny)))\b", re.I)
_REWIND = re.compile(r"\bwhat (?:was|were) i (?:doing|working on|watching|up to)\b|\bwhat did i (?:do|have open)\b", re.I)

HINTS = (
    (_MEDIA, "[Music/volume: do it with vyrse_controls now (action=media play_pause/next/previous, or volume). "
             "You haven't done it yet; call the tool before saying it's done.]"),
    (_RECORD, "[Start recording now: vyrse_notes action=record (title optional: use what they called it, or none). "
               "Don't ask first.]"),
    (_WEATHER, "[Weather: vyrse_briefing weather_only=true (now, today and the next 2 days, located automatically; "
               "a city only if they named one).]"),
    (_SHOT, "[Screenshot: vyrse_screen target=screen save=true; then say where it was saved.]"),
    (_FILES, "[Finding a file: vyrse_files action=find (an instant index of the whole PC). Not search_files, "
             "not the terminal. To open it after: vyrse_files action=open.]"),
    (_EMAIL, "[An email: write it in a card (vyrse_workspace kind=markdown: To, Subject, the text). Then offer to "
             "open it in their Gmail: vyrse_chrome action=open url=https://mail.google.com/mail/?view=cm&fs=1&su=SUBJECT&body=BODY "
             "(URL-encoded).]"),
    (_REWIND, "[What they were doing: vyrse_system action=rewind (day=yesterday, part=morning|afternoon|evening|night, "
              "at=HH:MM, date=YYYY-MM-DD as they said).]"),
    (_WEB, "[This changes over time: FIRST call web_search with a short query (e.g. 'iPhone 17 price India'), then answer "
           "from those results and name the source. web_extract only for a URL that search returned. Not from memory, "
           "not the browser.]"),
)


def hint_for(text: str) -> Optional[str]:
    for pattern, hint in HINTS:
        if pattern.search(text):
            return hint
    return None


def pre_llm_call(platform: str = "", user_message: Any = "", session_id: str = "", **_: Any) -> Optional[Dict[str, str]]:
    _done.pop(session_id, None)
    _reply.pop(session_id, None)
    text = str(user_message or "").strip()
    if platform != "vyrse" or not text or text.startswith("[") or len(text) > 800:
        return None
    now = time.strftime("%A %d %B %Y, %I:%M %p").replace(" 0", " ")
    parts = [f"[Now: {now}, this PC's local time. For the time or date, answer from this; no tool.]"]
    quick = run_quick(session_id, text) if len(text) < 60 else None
    if quick:
        parts.append(quick["context"])
        return {"context": " ".join(parts)}
    hint = hint_for(text)
    if hint:
        parts.append(hint)
    return {"context": " ".join(parts)}


# --------------------------------------------------------------------------------------- quick commands
# "pause it", "next song", "turn it down a bit", "mute": VYRSE does these itself, at once, like captions on/off.
# A small model would sometimes just say "I've paused it" without calling anything; and play/pause is a toggle,
# so the model must not press it again after VYRSE did (pre_tool_call turns that away).
_QUICK = (
    (re.compile(r"^(?:pause|pause it|pause (?:the )?(?:music|song|video|spotify|youtube))\W*$", re.I), {"action": "media", "command": "play_pause"}, "Paused."),
    (re.compile(r"^(?:play|resume|unpause|continue)(?: it| (?:the )?(?:music|song|video|spotify))?\W*$", re.I), {"action": "media", "command": "play_pause"}, "Playing."),
    (re.compile(r"^(?:next|skip)(?: (?:this )?(?:song|track|one))?\W*$|^next (?:song|track)\W*$", re.I), {"action": "media", "command": "next"}, "Next track."),
    (re.compile(r"^(?:previous|prev|go back|last)(?: (?:song|track|one))?\W*$", re.I), {"action": "media", "command": "previous"}, "Previous track."),
    (re.compile(r"^(?:turn (?:it|the (?:volume|music|sound)) up|volume up|louder)(?: a (?:bit|little))?(?: please| plz)?\W*$", re.I), {"action": "volume", "command": "up", "level": 10}, "Turned it up."),
    (re.compile(r"^(?:turn (?:it|the (?:volume|music|sound)) down|volume down|quieter|softer|lower (?:it|the volume))(?: a (?:bit|little))?(?: please| plz)?\W*$", re.I), {"action": "volume", "command": "down", "level": 10}, "Turned it down."),
    (re.compile(r"^mute(?: it| the (?:sound|volume|pc))?\W*$", re.I), {"action": "volume", "command": "mute"}, "Muted."),
    (re.compile(r"^unmute(?: it)?\W*$", re.I), {"action": "volume", "command": "unmute"}, "Unmuted."),
)
_SET_VOLUME = re.compile(r"^(?:set (?:the )?)?volume (?:to |at )?(\d{1,3})\s*%?\W*$", re.I)
_done: Dict[str, Dict[str, Any]] = {}  # session -> the control VYRSE already ran this turn
_reply: Dict[str, str] = {}


_STOP = re.compile(r"^(?:stop|stop it|stop that|stop everything|enough)\W*$", re.I)


def stop_what_is_running() -> Optional[str]:
    """A bare "stop": whatever VYRSE has going, most visible first. None when nothing is."""
    from . import captions, navigator

    if navigator.active.is_set() and navigator.cancel():
        return "Stopped the walkthrough."
    if getattr(captions, "_running", False):
        out = captions.handle({"action": "stop"})
        if '"ok": true' in out.replace("'", '"').lower():
            return "Captions off."
    try:
        from .controls import run

        if run({"action": "now_playing"}).get("playing") and run({"action": "media", "command": "play_pause"}).get("ok"):
            return "Paused."
    except Exception:
        pass
    return None


def quick_command(text: str) -> Optional[tuple]:
    t = text.strip()
    m = _SET_VOLUME.match(t)
    if m:
        level = max(0, min(100, int(m.group(1))))
        return {"action": "volume", "command": "set", "level": level}, f"Volume at {level}."
    for pattern, request, line in _QUICK:
        if pattern.match(t):
            return dict(request), line
    return None


def run_quick(session_id: str, text: str) -> Optional[Dict[str, str]]:
    import os

    if _STOP.match(text.strip()):
        if os.environ.get("VYRSE_TEST_DRY"):
            _reply[session_id] = "Stopped."
            return {"context": "[VYRSE stopped what was running (test run). Reply in a word or two.]"}
        line = stop_what_is_running()
        _reply[session_id] = line or "Nothing's running right now."
        _done[session_id] = {"action": "media"}
        return {"context": f"[VYRSE handled 'stop': {line or 'nothing was running'}. Reply in a few words; no tool needed.]"}
    found = quick_command(text)
    if not found:
        return None
    request, line = found
    if os.environ.get("VYRSE_TEST_DRY"):
        result: Dict[str, Any] = {"ok": True, "dry_run": True}
    else:
        from .controls import run

        try:
            if request.get("command") == "play_pause":
                # one key toggles both ways: only press it when it does what they asked
                playing = bool(run({"action": "now_playing"}).get("playing"))
                if playing == (line == "Playing."):
                    _reply[session_id] = "It's already playing." if playing else "Nothing's playing right now."
                    return {"context": "[Nothing to do: it's already in that state. Say so in a few words.]"}
            result = run(request)
        except Exception as exc:
            result = {"ok": False, "error": str(exc)}
    if not result.get("ok"):
        return {"context": f"[VYRSE tried {request} and it failed: {result.get('error')}. Say so in a few words.]"}
    _done[session_id] = request
    if request["action"] == "volume" and isinstance(result.get("volume"), int) and request["command"] in ("up", "down"):
        line = f"{line[:-1]}, to {result['volume']}%."
    _reply[session_id] = line
    return {"context": f"[VYRSE has already done it ({request['action']} {request['command']}). Reply in a few words; "
                       "don't call vyrse_controls again.]"}


def pre_tool_call(tool_name: str = "", args: Optional[Dict[str, Any]] = None, session_id: str = "", **_: Any) -> Optional[Dict[str, Any]]:
    done = _done.get(session_id)
    if tool_name == "vyrse_controls" and done and isinstance(args, dict) and args.get("action") == done["action"]:
        return {"action": "block", "message": '{"ok": true, "note": "Already done by VYRSE this turn; don\'t repeat it."}'}
    return None


def transform_llm_output(response_text: str = "", session_id: str = "", platform: str = "", **_: Any) -> Optional[str]:
    if platform != "vyrse":
        return None
    return _reply.pop(session_id, None)
