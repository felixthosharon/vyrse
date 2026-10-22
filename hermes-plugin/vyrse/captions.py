"""Live captions and translation over anything playing on the PC (videos, calls, streams, games).

The app captures the PC's own sound (loopback, not the mic), cuts it at pauses, and posts each piece here.
Speech is recognised on this PC with faster-whisper `small` on the CPU: the spoken language is worked out from the
first phrases and then locked (faster, and lines stop flipping language), and each phrase is heard with the one
before as context (names and topics stay consistent); ~1.5 s per 6 s phrase. When it isn't in the user's language
it's translated online (Google's public translate endpoint), or by Whisper itself into
English when offline. Captions appear in a bar over the screen. Nothing is saved.

Some languages get a model of their own once they're known (Whisper small barely knows Malayalam: it wrote Hindi
script): SPECIALISTS, CTranslate2 conversions of Whisper fine-tunes in %HERMES_HOME%/vyrse/models (setup.ps1).
"""
from __future__ import annotations

import json
import logging
import re
import sys
import time
import threading
from pathlib import Path
from typing import Any, Dict, Optional

LANGS = {
    "en": "English", "es": "Spanish", "fr": "French", "de": "German", "it": "Italian", "pt": "Portuguese",
    "hi": "Hindi", "ml": "Malayalam", "ta": "Tamil", "te": "Telugu", "kn": "Kannada", "bn": "Bengali", "mr": "Marathi",
    "ar": "Arabic", "ru": "Russian", "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "tr": "Turkish", "nl": "Dutch",
    "pl": "Polish", "id": "Indonesian", "vi": "Vietnamese", "th": "Thai", "uk": "Ukrainian", "ur": "Urdu",
}

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_captions",
    "description": (
        "Live captions over the whole screen for whatever is PLAYING on the PC (a video, a call, a stream, a game), "
        "translated into the user's language when it's in another one. action=start with to = language code (en, es, "
        "fr, de, hi, ml, ta, ja, ko, zh, ar, …; default en); action=stop. 'translate this video', 'subtitles for "
        "this', 'what are they saying'. Reply in a few words."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["start", "stop"]},
            "to": {"type": "string", "description": "start: language code to show captions in (their language; default en)."},
            "source": {"type": "string", "description": "start: the language being spoken, if they said it ('a Malayalam video' -> ml)."},
        },
        "required": ["action"],
    },
}

logger = logging.getLogger(__name__)
_models: Dict[str, Any] = {}
_model_lock = threading.Lock()
_run_lock = threading.Lock()

# language -> a Whisper fine-tuned for it (folder under %HERMES_HOME%/vyrse/models), used once that language is known
SPECIALISTS = {"ml": "whisper-small-ml"}


def _specialist_dir(lang: str) -> Optional[Path]:
    name = SPECIALISTS.get(lang or "")
    if not name:
        return None
    try:
        from hermes_constants import get_hermes_home

        path = Path(get_hermes_home()) / "vyrse" / "models" / name
    except Exception:
        return None
    return path if (path / "model.bin").is_file() else None


def _whisper(lang: str = ""):
    """The general model, or the one made for `lang` when there is one on this PC."""
    special = _specialist_dir(lang)
    key = str(special) if special else "small"
    with _model_lock:
        if key not in _models:
            from faster_whisper import WhisperModel

            _models[key] = WhisperModel(key, device="cpu", compute_type="int8", cpu_threads=6)
        return _models[key]


def _source_hint() -> str:
    """The language they said is playing ("a Malayalam video"), from the tool's start (the plugin's module copy;
    this file is also loaded on its own by the dashboard routes)."""
    mod = sys.modules.get("hermes_plugins.vyrse.captions")
    return str(getattr(mod, "_source", "") or "") if mod is not None else _source


_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"


def translate_online(text: str, to: str, source: str = "") -> Optional[str]:
    """Google's public endpoint, then MyMemory (both free, no key); None when offline or both refuse."""
    try:
        import requests
    except Exception:
        return None
    try:
        r = requests.get("https://translate.googleapis.com/translate_a/single", headers={"User-Agent": _UA},
                         params={"client": "gtx", "sl": source or "auto", "tl": to, "dt": "t", "q": text}, timeout=4)
        r.raise_for_status()
        out = "".join(part[0] for part in r.json()[0] if part and part[0]).strip()
        if out:
            return out
    except Exception:
        pass
    if source:
        try:
            r = requests.get("https://api.mymemory.translated.net/get", headers={"User-Agent": _UA},
                             params={"q": text[:480], "langpair": f"{source}|{to}"}, timeout=4)
            out = str(r.json().get("responseData", {}).get("translatedText") or "").strip()
            if out and "MYMEMORY WARNING" not in out.upper():
                return out
        except Exception:
            pass
    return None


# Per captions session (one "start"): the language once it's known, and the last line (context for the next).
_sessions: Dict[str, Dict[str, Any]] = {}


def text_matches(text: str, lang: str) -> bool:
    """Is the line written in that language's script? (Locked to a language, Whisper reports what it was told.)"""
    scripts = {"ml": "\u0d00-\u0d7f", "hi": "\u0900-\u097f", "mr": "\u0900-\u097f", "ta": "\u0b80-\u0bff",
               "te": "\u0c00-\u0c7f", "kn": "\u0c80-\u0cff", "bn": "\u0980-\u09ff", "ar": "\u0600-\u06ff",
               "ur": "\u0600-\u06ff", "ru": "\u0400-\u04ff", "uk": "\u0400-\u04ff", "ja": "\u3040-\u30ff\u4e00-\u9fff",
               "zh": "\u4e00-\u9fff", "ko": "\uac00-\ud7af", "th": "\u0e00-\u0e7f"}
    rng = scripts.get(lang)
    if not rng:
        return True  # Latin-script languages: can't tell by the letters
    letters = re.findall(r"\w", text)
    return bool(letters) and len(re.findall(f"[{rng}]", text)) >= 0.4 * len(letters)


def warm() -> Dict[str, Any]:
    """Load the model(s) as captions start, so the first line isn't slow (first ever use downloads it, ~480 MB)."""
    _whisper()
    if _source_hint():
        _whisper(_source_hint())
    return {"ok": True}


def chunk(pcm: bytes, to: str = "en", online: bool = True, session: str = "") -> Dict[str, Any]:
    """One phrase of the PC's audio (16 kHz mono int16) -> the line spoken, and in `to` if that's different."""
    import numpy as np

    to = to if to in LANGS else "en"
    if len(pcm) < 16000:  # under half a second
        return {"text": ""}
    audio = np.frombuffer(pcm[: len(pcm) // 2 * 2], np.int16).astype(np.float32) / 32768.0
    if float(np.sqrt(np.mean(audio ** 2))) < 0.004:  # silence
        return {"text": ""}
    state = _sessions.setdefault(session or "-", {"lang": _source_hint() or None, "votes": {}, "prev": ""})
    if len(_sessions) > 8:  # old sessions
        for k in list(_sessions)[:-8]:
            _sessions.pop(k, None)
    with _run_lock:  # one at a time; phrases queue up in order
        model = _whisper(state["lang"] or "")
        opts = dict(beam_size=1, vad_filter=True, condition_on_previous_text=False, no_speech_threshold=0.5)
        if state["prev"]:
            opts["initial_prompt"] = state["prev"][-220:]
        started = time.monotonic()
        segs, info = model.transcribe(audio, language=state["lang"], **opts)
        text = " ".join(s.text.strip() for s in segs if s.no_speech_prob < 0.6).strip()
        if state["lang"]:  # locked: what does the general model think is being spoken? (a new video?)
            try:
                code, prob, _ = _whisper().detect_language(audio)
                info = type("Info", (), {"language": code, "language_probability": prob})()
            except Exception:
                info = type("Info", (), {"language": state["lang"], "language_probability": 1.0})()
        lang = state["lang"] or info.language or ""
        if state["lang"] and info.language and info.language != state["lang"] and info.language_probability >= 0.8:
            # a different language now (they switched videos): hear this phrase again in it, and lock that
            logger.info("vyrse: captions hear %s now (was %s)", info.language, state["lang"])
            state.update(lang=info.language, votes={}, prev="")
            lang = info.language
            segs, _ = _whisper(lang).transcribe(audio, language=lang, beam_size=1, vad_filter=True,
                                                 condition_on_previous_text=False, no_speech_threshold=0.5)
            text = " ".join(s.text.strip() for s in segs if s.no_speech_prob < 0.6).strip()
        if not state["lang"] and _specialist_dir(info.language) and info.language_probability >= 0.5:
            # heard a language with a model of its own: lock it and hear this phrase again with that model
            state["lang"] = lang = info.language
            segs, _ = _whisper(lang).transcribe(audio, language=lang, beam_size=1, vad_filter=True,
                                                 condition_on_previous_text=False, no_speech_threshold=0.5)
            text = " ".join(s.text.strip() for s in segs if s.no_speech_prob < 0.6).strip()
        if state["lang"] is None and info.language and text:
            # lock the language after two confident phrases agree (or one very sure one)
            p = info.language_probability
            if p >= 0.6:
                state["votes"][info.language] = state["votes"].get(info.language, 0) + (2 if p >= 0.92 else 1)
                if state["votes"][info.language] >= 2:
                    state["lang"] = info.language
        logger.info("vyrse: captions %.1fs of audio -> %s %r (%.1fs)", len(audio) / 16000, lang, text[:60],
                    time.monotonic() - started)
        if not text or _junk(text):
            return {"text": ""}
        state["prev"] = text
        if lang == to:
            return {"text": text, "lang": lang}
        translated = translate_online(text, to, lang) if online else None  # private mode: nothing leaves the PC
        if translated is None and to == "en":  # offline: Whisper can translate into English itself
            segs, _ = _whisper().transcribe(audio, beam_size=1, task="translate", language=lang or None, vad_filter=True,
                                            condition_on_previous_text=False)
            translated = " ".join(s.text.strip() for s in segs).strip() or None
        if translated and translated.lower() != text.lower():
            return {"text": translated, "original": text, "lang": lang}
        return {"text": text, "lang": lang}


_JUNK = re.compile(r"^(?:thanks? (?:you )?for watching|subscribe|please subscribe|subtitles by|\W+|(\w+\W*)\1{3,})[.!?]*$", re.I)


def _junk(text: str) -> bool:
    """Whisper's well-known hallucinations on music or noise ("Thank you for watching!", "...", one word repeated)."""
    t = text.strip()
    words = t.lower().split()
    return bool(_JUNK.match(t)) or (len(words) >= 4 and len(set(words)) <= 1)


# Turning captions ON needs the user to have asked for them in their latest message: a model reaching for "a
# screenshot" once switched them back on right after the user had closed them.
_ASKED = re.compile(r"caption|subtit|translat|transcri|\bcc\b|what (?:are|is) (?:they|he|she|it) saying|"
                    r"(?:don'?t|do not|cant|can'?t) understand|in english|what language", re.I)


def asked_for_captions(text: str) -> bool:
    return bool(_ASKED.search(text or "") or _WANTS_ON.search(text or ""))


# Requests for live captions, typos and all ("transalte plz", "i dont understant this", "turn on subtitles"), as
# opposed to translating some text they typed (quotes or a long message).
_TRANSLATE = r"tra\w{0,3}l\w{0,3}t\w*"  # translate, transalte, translating, tranlate
_WANTS_ON = re.compile(rf"(caption|subtit|\bcc\b|{_TRANSLATE}|(?:don'?t|dont|cant|can'?t) under?stan\w*)", re.I)
_WANTS_OFF = re.compile(r"\b(stop|close|turn off|hide|remove|disable|no more|get rid of|kill)\b.{0,30}(caption|subtit|translat|\bcc\b|bar)"
                        r"|(caption|subtit|\bcc\b)\w*\s+(off|away)", re.I)
_RETRY = re.compile(r"\b(not (?:working|showing|on|there)|it(?:'s| is) not\b|isn'?t (?:working|showing|on)|try again|"
                    r"nothing (?:shows|showing|is showing|came|happened)|no captions|can'?t see (?:the |any )?captions?|again)\b", re.I)
_QUOTED = re.compile(r"[\"“'‘`].{4,}?[\"”'’`]")
_DEICTIC = re.compile(r"^(?:this|that|it|these|them|the video|this video|the audio|what (?:he|she|they)(?:'s| is| are|'re)? saying|"
                      r"for me|plz|please|pls|now|live)\b", re.I)


def typed_text_to_translate(text: str) -> bool:
    """'translate "where is the station" to Spanish' / 'translate good morning into French': words they typed,
    not the video playing. (Quotes of any kind, or real words between 'translate' and 'to <language>'.)"""
    if _QUOTED.search(text):
        return True
    m = re.search(rf"\b{_TRANSLATE}\s+(.+?)\s+(?:to|into|in)\s+\w+\s*[?.!]*$", text, re.I)
    return bool(m and not _DEICTIC.match(m.group(1).strip()))


_running = False
_running_to = ""
_source = ""


_reply: Dict[str, str] = {}  # session -> the line VYRSE says for a captions request it already carried out


def transform_llm_output(response_text: str = "", session_id: str = "", platform: str = "", **_: Any) -> Optional[str]:
    """The reply to "captions on/off" is VYRSE's own line: the model tends to add a lecture about its notes."""
    if platform != "vyrse":
        return None
    return _reply.pop(session_id, None)


def _languages(text: str) -> tuple:
    """(target, source) from what they said: 'into/to/in Spanish' is the target; any other language they name
    ('a Malayalam video', 'this is Tamil') is what's being spoken. The target defaults to English."""
    target, source = "en", ""
    for code, name in LANGS.items():
        if re.search(rf"\b(?:into|to|in)\s+{name}\b", text, re.I) and not re.search(rf"\b{name}\s+(?:video|movie|film|song|audio|show|clip)", text, re.I):
            target = code
        elif re.search(rf"\b{name[:5]}\w*", text, re.I) and code != "en":  # malayalam, malayalm, malyalam...
            source = source or code
    if source == target:
        source = ""
    return target, source


def pre_llm_call(platform: str = "", user_message: Any = "", session_id: str = "", **_: Any) -> Optional[Dict[str, str]]:
    """Live captions on or off, when that's what they asked for (a small model read "translate this" as
    "translate the text in my prompt"): VYRSE does it, and says so."""
    _reply.pop(session_id, None)
    text = str(user_message or "").strip()
    if platform != "vyrse" or not text or text.startswith("["):
        return None
    # VYRSE does these itself: a small model reads "translate this" as "explain the notes in my prompt".
    if _WANTS_OFF.search(text):
        out = json.loads(handle({"action": "stop"}))
        if out.get("ok"):
            _reply[session_id] = "Captions off."
        return {"context": "[VYRSE has turned the live captions OFF, as they asked. Say so in a few words; no tool needed.]"
                if out.get("ok") else "[They want the live captions off: call vyrse_captions action=stop.]"}
    if _running and _RETRY.search(text) and len(text) < 80:
        # they're on but nothing shows: start them again (the model used to switch them off here)
        to, src = _running_to or "en", _source
        handle({"action": "stop"})
        out = json.loads(handle({"action": "start", "to": to, "source": src, "_vyrse": True}))
        if out.get("ok"):
            _reply[session_id] = ("I've restarted the captions. They show at the bottom of the screen once someone "
                                  "speaks; make sure the video's sound is playing.")
            return {"context": "[VYRSE restarted the live captions. Say so in one sentence; no tool needed.]"}
    if len(text) > 160 or typed_text_to_translate(text):
        return None  # a passage to translate, not the video
    if _WANTS_ON.search(text) and not _running:
        lang, source = _languages(text)
        out = json.loads(handle({"action": "start", "to": lang, "source": source}))
        if out.get("ok"):
            _reply[session_id] = (f"Live captions are on, in {LANGS[lang]}. They'll appear at the bottom of your screen "
                                  "as people speak; say \"stop captions\" when you're done.")
            return {"context": f"[VYRSE has turned live captions ON for what's playing on their PC, in {LANGS[lang]}, as "
                               "they asked. Tell them in one short sentence that the captions are on; no tool needed, and "
                               "don't explain or translate anything else.]"}
        return {"context": f"[{out.get('error')} Tell them that in one sentence.]"}
    return None


def handle(params: Dict[str, Any], **_: Any) -> str:
    action = params.get("action")
    from .turn import said

    if action == "start" and not params.get("_vyrse") and said() and not asked_for_captions(said()):
        return json.dumps({"ok": False, "error": "Captions weren't asked for, so they stay off. (To read the screen use "
                                                 "vyrse_screen; to look at a web page, vyrse_chrome look.)"})
    to = str(params.get("to") or "en").lower()[:5]
    to = to if to in LANGS else next((code for code, name in LANGS.items() if name.lower() == to), "en")
    global _running, _source, _running_to
    if action == "start" and _running and _running_to == to:
        return json.dumps({"ok": True, "note": f"Captions are already on, in {LANGS[to]}. Reply in a few words."})
    _running = action == "start"
    _running_to = to if _running else ""
    if action == "start":
        src = str(params.get("source") or "").lower()[:5]
        src = src if src in LANGS else next((c for c, n in LANGS.items() if n.lower() == src), "")
        _source = src if src != to else ""
        if src and src == to and to != "en":  # "a Malayalam video" sent as to=ml: they want to understand it
            to = "en"
    try:
        from tools import desktop_ui

        sent = desktop_ui.emit("vyrse.ui", {"action": "captions", "op": "start" if action == "start" else "stop", "to": to})
    except Exception:
        sent = False
    if not sent:
        _running, _running_to = False, ""
        return json.dumps({"ok": False, "error": "Captions need the VYRSE window open on this PC."})
    if action == "start":
        return json.dumps({"ok": True, "note": f"Captions on, in {LANGS[to]}. Reply in a few words."})
    return json.dumps({"ok": True, "note": "Captions off."})
