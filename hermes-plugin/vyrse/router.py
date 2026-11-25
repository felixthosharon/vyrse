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

# 2026-11-14 battery: "tidy my desktop" went to the file organizer (no windows touched); "when i say im heading out,
# save my work and lock my pc" saved and locked at once instead of making the routine.
_TIDY = re.compile(r"\b(?:tidy|clean|sort|organi[sz]e|arrange)(?: up| out)?\s+(?:my |the |all (?:my |the )?)?"
                   r"(?:desktop|windows|screen)\b(?!\s+(?:files?|icons?|folders?|shortcuts?))", re.I)
_ROUTINE = re.compile(r"^\s*(?:(?:so |ok(?:ay)? |yo )?(?:when(?:ever)?|if|each time|every time) i say)\b", re.I)

# 2026-11-15: "play lofi on spotify" only pressed play/pause (there was no search); "how much have you saved me"
# had no source (the figure was only in Settings).
_PLAY = re.compile(r"^\s*(?:(?:can|could) you |pls |please |yo )?(?:play|put on|throw on|queue up|start playing)\s+"
                   r"(?!(?:it|this|that|music|the music|some music|the song|spotify|a game|games?|with)\W*$)"
                   r"(?!(?:a |some |the )?games?\b|with\b)\S.{0,80}$", re.I)
_SAVINGS = re.compile(r"\b(?:how much|what) (?:money |cash )?(?:have|has|did|do) (?:you|vyrse|u) (?:saved?|save)\b|"
                      r"\bsav(?:ed|ings) (?:me|on|by)\b|\bmy savings\b|\bhow much (?:would|did) (?:it|this|that|chatgpt|claude|the api) (?:have )?cost", re.I)

# 2026-11-17 battery: "quiz me on the solar system" came back with the tool call written out as text (no quiz
# started); "what can you do" listed raw tool names; "open notepad and type hello world" opened Notepad, said
# "now let me type" and stopped.
_QUIZ = re.compile(r"^\s*(?:(?:can|could) you |pls |please |yo |ok(?:ay)? )?(?:quiz|test) me\b", re.I)
_CAN_DO = re.compile(r"\bwhat (?:all )?(?:can|could) (?:you|u) (?:even |actually )?do\b|\bwhat are you (?:able to do|capable of)\b|"
                     r"\bwhat (?:are|r) your (?:features|skills|abilities)\b|^\s*help\W*$", re.I)
_ACT = (r"(?:open|launch|start|type|write|paste|play|pause|turn|set|close|search|google|send|save|lock|take|mute|unmute|"
        r"remind|show|find|read|copy|switch|dim|put|make|create|tell|check|delete|move|tidy)")
_MULTI = re.compile(rf"^\s*(?:(?:can|could) you |pls |please |yo )?{_ACT}\b.{{2,120}}?(?:,|\band then\b|\bthen\b|\band\b)\s*(?:also |then )?"
                    rf"{_ACT}\b", re.I | re.S)
MULTI_HINT = ("[They asked for more than one thing. Do every part with its own tool call, in order, in this same turn. "
              "Don't announce a step (\"now let me...\"): make the call. Write your reply only after the last one, "
              "and say which parts worked.]")

_HOW_TO = re.compile(r"\s*(?:how (?:do|can|to|would|should)|what(?:'s| is) the (?:way|shortcut|key)|which (?:key|shortcut))\b", re.I)

HINTS = (
    (_ROUTINE, "[A new routine: vyrse_routine action=create name=<the phrase they'll say> steps=<what they described, "
               "in order, naming the VYRSE tool for each>. It isn't saved yet: call vyrse_routine BEFORE saying it's set up. "
               "Don't do the steps now.]"),
    (_TIDY, "[Tidy the open windows: vyrse_desktop action=tidy (lays them out side by side in one go; closes nothing). "
            "Not the file organizer: only sort files if they said files, icons or folders.]"),
    (_PLAY, "[If this is music: vyrse_controls action=play query=<the song, artist, playlist or mood> (searches Spotify "
            "and starts it; for their own Liked Songs or playlists keep 'my': query='my liked songs', 'my gym playlist'). Not action=media: that only toggles what's loaded. Say what it reports is playing. "
            "If it's a game or an app, open it instead.]"),
    (_SAVINGS, "[Money saved: vyrse_system action=savings (days=30 default, 7 for this week, 365 for all time). Give "
               "the dollar figure it returns.]"),
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
    (_QUIZ, "[A quiz: make a REAL tool call to vyrse_quiz now (action=start, subject=<topic>, text=<one question per "
            "line as 'question :: answer :: topic'>, 5 questions unless they gave a number). Never write the call out "
            "as text. After it returns, greet in a line and ask question 1.]"),
    (_CAN_DO, "[Say what you can do in plain words, 6 short lines at most, no tool names and no code: talk or type to "
              "you; open apps, type into them and tidy windows; music, volume and brightness; read the screen and explain "
              "anything on it (Ctrl+Alt+E to box something); find files; reminders, alarms, timers and routines; search "
              "the web; quizzes, charts and notes on the board; their phone and Echo. End with one thing to try.]"),
    (_REWIND, "[What they were doing: vyrse_system action=rewind (day=yesterday, part=morning|afternoon|evening|night, "
              "at=HH:MM, date=YYYY-MM-DD as they said).]"),
    (_WEB, "[This changes over time: FIRST call web_search with a short query (e.g. 'iPhone 17 price'), then answer "
           "from those results and name the source. web_extract only for a URL that search returned. Not from memory, "
           "not the browser.]"),
)


def is_multi(text: str) -> bool:
    """Two or more actions in one request ("open notepad and type hello", "play lofi, then turn it down")."""
    return bool(_MULTI.match(text)) and not _HOW_TO.match(text) and not _ROUTINE.match(text)


def hint_for(text: str) -> Optional[str]:
    # "how do I take a screenshot?" asks for the way, not for one to be taken
    how_to = bool(_HOW_TO.match(text))
    for pattern, hint in HINTS:
        if how_to and pattern in (_SHOT, _RECORD, _EMAIL, _MEDIA, _PLAY):
            continue
        if pattern.search(text):
            return hint
    return None


def pre_llm_call(platform: str = "", user_message: Any = "", session_id: str = "", **_: Any) -> Optional[Dict[str, str]]:
    _done.pop(session_id, None)
    _reply.pop(session_id, None)
    _screen_read.discard(session_id)
    text = str(user_message or "").strip()
    if platform != "vyrse" or not text or text.startswith("[") or len(text) > 800:
        return None
    now = time.strftime("%A %d %B %Y, %I:%M %p").replace(" 0", " ")
    parts = [f"[Now: {now}, this PC's local time. For the time or date, answer from this; no tool.]"]
    quick = run_quick(session_id, text) if len(text) < 60 else _make_routine(session_id, text)
    if quick:
        parts.append(quick["context"])
        return {"context": " ".join(parts)}
    hint = hint_for(text)
    if hint:
        parts.append(hint)
    if is_multi(text):
        parts.append(MULTI_HINT)
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
    style = style_switch(text)
    if style:
        return _switch_style(session_id, style)
    made = _make_routine(session_id, text)
    if made:
        return made
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


# "when I say heading out, save my work and lock my PC": VYRSE saves the routine itself when the phrase and the steps
# are clearly separated (a comma, quotes, "then", a colon). Left to the model it was saved two times out of three
# (2026-11-14 battery); the third time it only said so, or ran the steps at once.
_ROUTINE_SPLIT = re.compile(
    r"^\s*(?:so |ok(?:ay)? |yo )?(?:when(?:ever)?|if|each time|every time) i say\s+"
    r"(?:[\"“'‘](?P<quoted>[^\"”'’]{3,40})[\"”'’]\s*[,:]?\s*(?:then\s+)?|(?P<plain>[^,:;]{3,40}?)\s*(?:[,:;]\s*(?:then\s+)?|\s+then\s+))"
    r"(?:(?:i want you to|you should|you|please|pls|just)\s+)*(?P<steps>\S.{8,600})$", re.I | re.S)


def routine_parts(text: str) -> Optional[tuple]:
    """(phrase, steps) when the message spells out a routine with a clear break between the two."""
    m = _ROUTINE_SPLIT.match(text.strip())
    if not m:
        return None
    name = (m.group("quoted") or m.group("plain") or "").strip()
    steps = m.group("steps").strip().rstrip(".! ")
    if "?" in steps[-3:] or "?" in text.strip()[-2:]:  # "when I say hello, what do you say?" is a question
        return None
    return (name, steps) if len(name) >= 3 and len(steps) >= 10 else None


def _make_routine(session_id: str, text: str) -> Optional[Dict[str, str]]:
    import json
    import os

    parts = routine_parts(text)
    if not parts:
        return None
    name, steps = parts
    if os.environ.get("VYRSE_TEST_DRY") and "vyrse_routine" not in os.environ.get("VYRSE_TEST_ALLOW", "").split(","):
        saved = name.lower()
    else:
        from . import routines

        try:
            out = json.loads(routines.handle({"action": "create", "name": name, "steps": steps}))
        except Exception as exc:
            out = {"ok": False, "error": str(exc)}
        if not out.get("ok"):
            return {"context": f"[Saving that routine failed: {out.get('error')}. Say so in a line; don't run the steps.]"}
        saved = out["saved"]
    _done[session_id] = {"action": "routine"}
    _reply[session_id] = f"Saved. Say “{saved}” and I'll {steps[0].lower() + steps[1:]}."
    return {"context": f"[VYRSE has already saved the routine “{saved}”. Confirm in one line; don't run its steps now and "
                       "don't call any tool.]"}


# "switch to savage mode", "chill mode", "back to normal": the talk style, switched by VYRSE itself. Left to the model
# it sometimes only said "switching to chill mode" (and stayed as it was), and read "focus mode" as a study session.
_STYLE_ASK = (
    r"^(?:(?:please |plz |ok(?:ay)? |hey |yo )?(?:switch|change|go|set(?: it)?|turn)(?: (?:it|me|us|back|over))*"
    r" (?:to|into|on) )?(?:the )?(?:talk(?:ing)? style (?:to )?)?(?P<name>{names})(?: (?:mode|style|talk style|vibe))?"
    r"(?: (?:please|plz|now))?\W*$")
_STYLE_WORD = r"(?:mode|style|talk style)"


def style_switch(text: str) -> Optional[str]:
    """The talk style they asked to switch to (its id), or None. A bare style name alone isn't a switch
    ("chill", "normal"): it needs "switch to ..." or "... mode"."""
    from . import talk_styles

    names = {sid: sid for sid in talk_styles.STYLES}
    try:
        from . import styles

        names.update({str(v.get("label", "")).lower(): k for k, v in styles.load().items() if v.get("label")})
    except Exception:
        pass
    t = text.strip().lower()
    back = re.match(r"^(?:ok(?:ay)? |and |now )?(?:(?:go|switch|change) )?back to (?:the )?(?P<name>"
                    + "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True))
                    + r")(?: (?:mode|style|talk style|vibe))?(?: (?:please|plz|now))?\W*$", t)
    if back:
        return names[back.group("name")]
    pattern = _STYLE_ASK.replace("{names}", "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True)))
    m = re.match(pattern, t)
    if not m:
        return None
    asked = re.match(r"^(?:please |plz |ok(?:ay)? |hey |yo )?(?:switch|change|go|set|turn)\b", t) or re.search(rf"\b{_STYLE_WORD}\b", t)
    return names[m.group("name")] if asked else None


def _switch_style(session_id: str, style: str) -> Dict[str, str]:
    import json
    import os

    from . import talk_styles, tools

    label = (talk_styles.STYLES.get(style) or {}).get("label") or style.split(":", 1)[-1].title()
    dry = os.environ.get("VYRSE_TEST_DRY") and "vyrse_ui" not in os.environ.get("VYRSE_TEST_ALLOW", "").split(",")
    if not dry:
        try:
            out = json.loads(tools.handle({"action": "set", "preferences": {"talkStyle": style}}))
        except Exception as exc:
            out = {"error": str(exc)}
        if not (out.get("applied") or {}).get("talkStyle"):
            return {"context": f"[Switch the talk style with vyrse_ui action=set preferences={{talkStyle: {style}}} now, "
                               "before saying it's done.]"}
    _done[session_id] = {"action": "style"}
    extra = " Short answers from here. For a distraction-free study session, say 'help me focus'." if style == "focus" else ""
    _reply[session_id] = f"{label} style on.{extra}"
    return {"context": f"[VYRSE has already switched the talk style to {label}. Reply in a few words; no tool needed.]"}


# 2026-11-14 battery: after "what's on my screen?" the model once started guide rings nobody asked for (text it read
# on the screen steered it). A walkthrough after a screen read needs the user to have asked how or where.
_GUIDE_ASKED = re.compile(r"\b(?:how (?:do|can|to|would|should)|where (?:do|is|are|can|should)|show me|guide|walk me|point|"
                          r"highlight|help me|teach me|which button|what do i (?:click|press)|do it for me|step by step)\b", re.I)
_screen_read: set = set()


def pre_tool_call(tool_name: str = "", args: Optional[Dict[str, Any]] = None, session_id: str = "", **_: Any) -> Optional[Dict[str, Any]]:
    if tool_name == "vyrse_screen":
        _screen_read.add(session_id)
    elif tool_name == "vyrse_point" and session_id in _screen_read and isinstance(args, dict) and args.get("action", "guide") == "guide":
        from . import turn

        if not _GUIDE_ASKED.search(turn.said()):
            return {"action": "block", "message": '{"ok": false, "note": "They asked what is on the screen, not how to do '
                                                  'something. Answer from what you read; no walkthrough."}'}
    done = _done.get(session_id)
    if done and done.get("action") == "style":  # nothing else was asked for: no timers, no second switch
        return {"action": "block", "message": '{"ok": true, "note": "The talk style is already switched; nothing more to do."}'}
    if done and done.get("action") == "routine":  # it was only being set up: its steps must not run now
        return {"action": "block", "message": '{"ok": true, "note": "The routine is saved. Nothing to run now; just confirm."}'}
    if tool_name == "vyrse_controls" and done and isinstance(args, dict) and args.get("action") == done["action"]:
        return {"action": "block", "message": '{"ok": true, "note": "Already done by VYRSE this turn; don\'t repeat it."}'}
    return None


def transform_llm_output(response_text: str = "", session_id: str = "", platform: str = "", **_: Any) -> Optional[str]:
    if platform != "vyrse":
        return None
    return _reply.pop(session_id, None)
