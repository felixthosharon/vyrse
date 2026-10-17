"""Kokoro text-to-speech for Hermes (local, offline), registered by the vyrse plugin.

- `KokoroTTSProvider` services `tts.provider: kokoro` (the text_to_speech tool, /api/audio/speak).
- `KokoroStreamer` feeds Hermes' sentence-streaming path (/api/audio/speak-stream), so VYRSE
  starts speaking after the first sentence instead of after the whole reply.

The model stays loaded once warm (≈0.5 GB RAM) and is released after `idle_unload_s` of silence.
Config (`tts.kokoro` in Hermes config.yaml): voice (af_heart), speed (1.0), threads (4),
model_dir (default %HERMES_HOME%/vyrse/models/kokoro), idle_unload_s (600; 0 = never).

Dependencies live in %HERMES_HOME%/vyrse/pylib (kokoro-onnx, phonemizer, espeakng-loader); numpy and
onnxruntime come from the Hermes venv. See scripts/setup.ps1.
"""
from __future__ import annotations

import logging
import os
import sys
import threading
import time
import wave
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from agent.tts_provider import TTSProvider
from tools.tts_streaming import StreamingTTSProvider

logger = logging.getLogger(__name__)

SAMPLE_RATE = 24000
DEFAULT_VOICE = "af_heart"


def _vyrse_dir() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / "vyrse"


def _section() -> Dict[str, Any]:
    try:
        from hermes_cli.config import load_config_readonly
        tts = load_config_readonly().get("tts") or {}
        section = tts.get("kokoro") if isinstance(tts, dict) else None
        return section if isinstance(section, dict) else {}
    except Exception:
        return {}


class _Engine:
    """Process-wide Kokoro instance: loaded lazily, guarded by a lock, released when idle."""

    _lock = threading.Lock()
    _kokoro = None
    _last_used = 0.0
    _sweeper: Optional[threading.Thread] = None

    @classmethod
    def model_dir(cls) -> Path:
        configured = _section().get("model_dir")
        return Path(configured) if configured else _vyrse_dir() / "models" / "kokoro"

    @classmethod
    def available(cls) -> bool:
        model_dir = cls.model_dir()
        if not (model_dir / "kokoro-v1.0.onnx").is_file() or not (model_dir / "voices-v1.0.bin").is_file():
            return False
        cls._ensure_path()
        try:
            import kokoro_onnx  # noqa: F401
            return True
        except Exception:
            return False

    @staticmethod
    def _ensure_path() -> None:
        pylib = str(_vyrse_dir() / "pylib")
        if os.path.isdir(pylib) and pylib not in sys.path:
            sys.path.append(pylib)  # appended: the Hermes venv's own packages always win

    @classmethod
    def get(cls):
        with cls._lock:
            if cls._kokoro is None:
                cls._ensure_path()
                import onnxruntime as ort
                from kokoro_onnx import Kokoro

                section = _section()
                options = ort.SessionOptions()
                options.intra_op_num_threads = int(section.get("threads", 4))
                options.inter_op_num_threads = 1
                options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                model_dir = cls.model_dir()
                started = time.time()
                session = ort.InferenceSession(str(model_dir / "kokoro-v1.0.onnx"), options, providers=["CPUExecutionProvider"])
                cls._kokoro = Kokoro.from_session(session, str(model_dir / "voices-v1.0.bin"))
                logger.info("Kokoro TTS loaded in %.1fs", time.time() - started)
                cls._start_sweeper()
            cls._last_used = time.time()
            return cls._kokoro

    @classmethod
    def release(cls) -> None:
        with cls._lock:
            if cls._kokoro is not None:
                cls._kokoro = None
                logger.info("Kokoro TTS released")

    @classmethod
    def _start_sweeper(cls) -> None:
        if cls._sweeper is not None and cls._sweeper.is_alive():
            return

        def _loop() -> None:
            while True:
                time.sleep(30)
                idle = float(_section().get("idle_unload_s", 600))
                if idle > 0 and cls._kokoro is not None and time.time() - cls._last_used > idle:
                    cls.release()
                if cls._kokoro is None:
                    return

        cls._sweeper = threading.Thread(target=_loop, daemon=True, name="vyrse-kokoro-idle")
        cls._sweeper.start()

    @classmethod
    def synth(cls, text: str, voice: Optional[str], speed: Optional[float]):
        section = _section()
        kokoro = cls.get()
        audio, sample_rate = kokoro.create(
            apply_pronunciations(text, section.get("pronunciations")),
            voice=voice or section.get("voice") or DEFAULT_VOICE,
            speed=float(speed or section.get("speed") or 1.0),
            lang=str(section.get("lang") or "en-us"),
        )
        cls._last_used = time.time()
        return audio, sample_rate


# How words Kokoro gets wrong should sound, as respellings it reads correctly. The user says the
# assistant's name "Vyse" (/vaɪz/, rhymes with wise); espeak alone reads "VYRSE" as "veer-s".
# Override or extend with tts.kokoro.pronunciations: {"VYRSE": "Vyse", ...}.
DEFAULT_PRONUNCIATIONS = {"VYRSE": "Vyse"}

# Chat slang the way people actually say it. espeak spells most of these letter by letter ("ngl" ->
# "N G L", "wsup" -> "double-you sup"); words people do say as letters (omg, gg, dm, afk) stay as they are.
SLANG_PRONUNCIATIONS = {
    "wsup": "wassup", "wassup": "wassup", "whassup": "wassup", "sup": "sup",
    "ngl": "not gonna lie", "fr": "for real", "frfr": "for real for real", "tbh": "to be honest",
    "tbf": "to be fair", "idk": "I dunno", "idc": "I don't care", "imo": "in my opinion",
    "imho": "in my honest opinion", "rn": "right now", "btw": "by the way", "lmao": "lahmao",
    "lmfao": "lahmao", "smh": "shaking my head", "irl": "in real life", "ikr": "I know, right",
    "nvm": "never mind", "ty": "thank you", "tysm": "thank you so much", "thx": "thanks", "pls": "please",
    "plz": "please", "wyd": "whatchu doin", "hbu": "how about you", "wbu": "what about you",
    "istg": "I swear to god", "ong": "on god", "iykyk": "if you know, you know", "ig": "I guess",
    "ofc": "of course", "ur": "your", "u": "you", "aight": "ight", "tryna": "trynuh", "jk": "just kidding",
    "hmu": "hit me up", "glhf": "good luck, have fun", "ez": "easy", "periodt": "period", "yoo": "yo",
    "broo": "bro", "bruhh": "bruh", "rly": "really", "srsly": "seriously", "abt": "about", "bc": "because",
    "cuz": "cuz", "w/": "with", "w/o": "without", "gtg": "got to go", "g2g": "got to go", "ttyl": "talk to you later",
    "gng": "gang", "wym": "what you mean", "wdym": "what do you mean", "icl": "I can't lie",
    "iono": "I dunno", "oml": "oh my lord", "ykwim": "you know what I mean", "wassgood": "wass good",
    # Dropped-g words whose verb loses its silent "e" (vibe -> vibin): espeak guesses a short vowel
    # ("vibbin"), so they are respelled to keep the long one. Plain ones (doin, chillin) already sound right.
    "vibin": "vybin", "ridin": "rydin", "hidin": "hydin", "drivin": "dryvin", "smilin": "smylin",
    "slidin": "slydin", "wilin": "wylin", "writin": "rytin", "bitin": "bytin", "risin": "ryzin",
    "gamin": "gaymin", "fadin": "faydin", "blazin": "blayzin", "hatin": "haytin", "makin": "maykin",
    "takin": "taykin", "bakin": "baykin", "wakin": "waykin", "shakin": "shaykin", "fakin": "faykin",
    "comin": "kummin", "provin": "proovin", "choosin": "choozin", "losin": "loozin", "hostin": "hoastin",
    "jokin": "joakin", "smokin": "smoakin", "pokin": "poakin", "ballin": "bawlin", "skatin": "skaytin",
    "racin": "raycin", "cravin": "crayvin", "savin": "sayvin", "hopin": "hoapin", "glidin": "glydin",
}

_TABLE_CACHE: Dict[str, Any] = {}


def _compiled(overrides: Optional[Dict[str, str]]):
    """One case-insensitive alternation over every word (longest first), compiled once per table."""
    import re

    extra = overrides if isinstance(overrides, dict) else {}
    key = repr(sorted(extra.items()))
    if key not in _TABLE_CACHE:
        table = {k.lower(): str(v) for k, v in {**SLANG_PRONUNCIATIONS, **DEFAULT_PRONUNCIATIONS, **extra}.items()
                 if k and v}
        words = sorted(table, key=len, reverse=True)
        # Not inside paths, flags, URLs or abbreviations: no letter, digit, "-", "/", "\\" or "." around it
        # (a sentence-ending "." is fine).
        pattern = re.compile(
            r"(?<![\w\-/\\.])(" + "|".join(re.escape(w) for w in words) + r")(?![\w\-/\\]|\.\w)", re.IGNORECASE)
        _TABLE_CACHE.clear()
        _TABLE_CACHE[key] = (pattern, table)
    return _TABLE_CACHE[key]


_STRETCH = None


def apply_pronunciations(text: str, overrides: Optional[Dict[str, str]] = None) -> str:
    import re

    global _STRETCH
    if _STRETCH is None:
        _STRETCH = re.compile(r"([a-z])\1{2,}", re.IGNORECASE)
    # "yooo", "brooo", "sooo" -> one letter: stretched spellings get spelled out otherwise.
    text = _STRETCH.sub(r"\1", text)
    pattern, table = _compiled(overrides)

    def swap(m):
        word = m.group(1)
        # "u"/"ur" only as lowercase chat words; "U"/"UR" are usually names or abbreviations.
        if word.lower() in _LOWERCASE_ONLY and word != word.lower():
            return word
        return table[word.lower()]

    return pattern.sub(swap, text)


_LOWERCASE_ONLY = {"u", "ur", "bc", "ty", "ig"}


def _to_pcm16(audio) -> bytes:
    import numpy as np
    clipped = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


class KokoroTTSProvider(TTSProvider):
    """`tts.provider: kokoro` — writes WAV (Kokoro has no MP3/Opus encoder; Hermes converts if needed)."""

    @property
    def name(self) -> str:
        return "kokoro"

    @property
    def display_name(self) -> str:
        return "Kokoro (local)"

    def is_available(self) -> bool:
        return _Engine.available()

    def list_voices(self) -> List[Dict[str, Any]]:
        if not _Engine.available():
            return []
        try:
            return [{"id": v, "display": v} for v in sorted(_Engine.get().get_voices())]
        except Exception:
            return [{"id": DEFAULT_VOICE, "display": DEFAULT_VOICE}]

    def default_voice(self) -> Optional[str]:
        return _section().get("voice") or DEFAULT_VOICE

    def synthesize(self, text: str, output_path: str, *, voice: Optional[str] = None, model: Optional[str] = None,
                   speed: Optional[float] = None, format: str = "wav", **extra: Any) -> str:
        audio, sample_rate = _Engine.synth(text, voice, speed)
        path = Path(output_path)
        if path.suffix.lower() != ".wav":
            path = path.with_suffix(".wav")
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(_to_pcm16(audio))
        return str(path)

    def warm(self) -> None:
        if _Engine.available():
            _Engine.get()

    def release(self) -> None:
        _Engine.release()


def _style_voice() -> Optional[str]:
    """The voice the user picked for the current talk style (Settings -> Voice), if any."""
    try:
        from . import talk_styles, ui_state

        return (ui_state.load().get("styleVoices") or {}).get(talk_styles.current()) or None
    except Exception:
        return None


class KokoroStreamer(StreamingTTSProvider):
    """Sentence-level streaming for /api/audio/speak-stream: one PCM chunk per sentence."""

    sample_rate = SAMPLE_RATE

    @staticmethod
    def available() -> bool:
        return _Engine.available()

    def stream(self, text: str) -> Iterator[bytes]:
        audio, sample_rate = _Engine.synth(text, _style_voice() or self.section.get("voice"), self.section.get("speed"))
        self.sample_rate = sample_rate
        yield _to_pcm16(audio)
