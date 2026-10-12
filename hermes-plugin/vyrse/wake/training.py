"""Teach VYRSE your voice: in-app wake-word training.

The user records their own "VYRSE" takes and a little everyday speech (Settings → Voice); this module trains
a personal wake-word model on them in the background and installs it once it checks out:

  1. a separate trainer environment (heed-wakeword + CPU-only torch, ~250 MB, made once with uv);
  2. "not the wake word" examples: the user's own speech + distractor words and sentences voiced by
     Kokoro (look-alikes such as "wise", "why", "five"), generated once and cached;
  3. training (~1 minute) and a check on takes held out of training and on speech it never saw;
  4. install: the previous model is kept as a backup, the new one takes over (PC, and the phone via
     /wake-model) the next time listening starts.

Everything stays under %HERMES_HOME%/vyrse. Nothing is uploaded anywhere.
"""
from __future__ import annotations

import json
import logging
import random
import shutil
import subprocess
import threading
import time
import uuid
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

SR = 16000
MAX_TAKES = 20
LIMITS = {"wake": (0.3, 3.0), "other": (1.0, 10.0)}  # seconds per recording
HELD_OUT = 2
# Exact versions, so the trainer never silently picks up a new (or hijacked) release.
TRAINER_PACKAGES = ["torch==2.14.1", "heed-wakeword==0.1.3", "scipy==1.18.1", "soundfile==0.14.0", "numpy==2.5.3", "click==8.5.0"]

_lock = threading.Lock()
_job_lock = threading.Lock()  # start/clear vs. a running job
_state: Dict[str, Any] = {"phase": "idle", "message": ""}
_thread: Optional[threading.Thread] = None

_DISTRACTOR_WORDS = [
    "nice", "rice", "price", "vice", "verse", "first", "worse", "voice", "vibe", "eyes", "size", "hi", "hey", "okay",
    "five", "my", "white", "wise", "why", "while", "versus", "Alexa", "hello", "right", "sure", "fire", "twice",
    "advice", "device", "surprise", "rise", "guys", "prize",
]
_DISTRACTOR_SENTENCES = [
    "Why is the server down again?", "That was a wise move.", "Five more minutes, I'm almost done.",
    "Give me some advice on this.", "The device keeps disconnecting.", "What a surprise, honestly.",
    "Open Chrome and check my email.", "What time is it right now?", "Play some music please.",
    "I'll be there in a while.", "The price went up again.", "Nice, that worked first try.",
    "Turn the volume down a bit.", "Set a timer for ten minutes.", "Let's go, one more game.",
    "Why not, it's fine by me.", "Wise words from the man himself.", "Whatever, that's fine.",
]
# Never used for training: the check that the new model doesn't fire on everyday speech.
_CHECK_SENTENCES = [
    "Yesterday I finally beat the boss after forty tries, and it felt amazing.",
    "Can you remind me to submit the assignment before Friday?",
    "Why is my Wi-Fi so slow right now? Try restarting the router.",
    "Nice shot, that was a clean round, they did not see it coming.",
    "I think the wise choice is to save the file first and then close it.",
    "Five minutes left, wrap it up, we have to leave soon.",
]


def _base() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "vyrse"


def _folder(kind: str) -> Path:
    return _base() / "wake-train" / ("positive" if kind == "wake" else "negative")


def _set(phase: str, message: str, **extra: Any) -> None:
    with _lock:
        _state.clear()
        _state.update({"phase": phase, "message": message, "at": time.time(), **extra})
    logger.info("vyrse wake training: %s - %s", phase, message)


def counts() -> Dict[str, int]:
    return {k: len(list(_folder(k).glob("*.wav"))) if _folder(k).is_dir() else 0 for k in ("wake", "other")}


def status() -> Dict[str, Any]:
    with _lock:
        snapshot = dict(_state)
    snapshot["takes"] = counts()
    snapshot["running"] = bool(_thread and _thread.is_alive())
    return snapshot


def _write_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)


def save_sample(kind: str, pcm: bytes) -> Dict[str, Any]:
    """Store one recording (16 kHz mono int16 PCM). `kind` is "wake" (the user saying VYRSE) or "other"."""
    if kind not in LIMITS:
        raise ValueError("kind must be wake or other")
    lo, hi = LIMITS[kind]
    seconds = len(pcm) / 2 / SR
    if len(pcm) % 2 or not lo <= seconds <= hi:
        raise ValueError(f"a {kind} recording must be {lo}-{hi} s of 16 kHz mono int16 audio")
    folder = _folder(kind)
    folder.mkdir(parents=True, exist_ok=True)
    if len(list(folder.glob("*.wav"))) >= MAX_TAKES:
        raise ValueError(f"already {MAX_TAKES} {kind} recordings; clear them to start again")
    _write_wav(folder / f"{kind}-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}.wav", pcm)
    return counts()


def clear() -> Dict[str, int]:
    if _thread and _thread.is_alive():
        raise ValueError("training is running; wait for it to finish")
    shutil.rmtree(_base() / "wake-train" / "positive", ignore_errors=True)
    shutil.rmtree(_base() / "wake-train" / "negative", ignore_errors=True)
    return counts()


def start() -> Dict[str, Any]:
    global _thread
    with _job_lock:
        if counts()["wake"] < 5:
            raise ValueError("record at least 5 takes of you saying VYRSE first")
        if _thread and _thread.is_alive():
            raise ValueError("training is already running")
        _set("preparing", "Starting...")
        _thread = threading.Thread(target=_run, name="vyrse-wake-training", daemon=True)
        _thread.start()
    return status()


# --------------------------------------------------------------------------------------- the job


def _uv() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "bin" / "uv.exe"


def _run_cmd(args: List[str], timeout: int, cwd: Optional[Path] = None) -> subprocess.CompletedProcess:
    from hermes_cli._subprocess_compat import windows_hide_flags

    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                          stdin=subprocess.DEVNULL, creationflags=windows_hide_flags(), cwd=str(cwd) if cwd else None)


def _trainer_python() -> Path:
    """The trainer environment, made once: heed-wakeword with CPU-only torch (no CUDA download)."""
    env = _base() / "trainer"
    py = env / "Scripts" / "python.exe"
    marker = env / "vyrse-trainer-ready"
    if py.is_file() and marker.is_file() and marker.read_text(encoding="utf-8").split() == TRAINER_PACKAGES:
        return py
    _set("preparing", "Setting up the trainer (one time, about 250 MB)...")
    uv = str(_uv())
    env.parent.mkdir(parents=True, exist_ok=True)
    # --no-config: Hermes' own uv settings (e.g. its package-age quarantine) are for Hermes, not this env.
    # On Windows the torch wheel from PyPI is the CPU build (no multi-GB CUDA download).
    steps = [
        [uv, "venv", str(env), "--python", "3.12", "--allow-existing", "--no-config"],
        [uv, "pip", "install", "--no-config", "--python", str(py), *TRAINER_PACKAGES],
    ]
    for cmd in steps:
        r = _run_cmd(cmd, timeout=1800, cwd=env.parent)
        if r.returncode != 0:
            raise RuntimeError(f"trainer setup failed: {(r.stderr or r.stdout).strip()[-300:]}")
    marker.write_text("\n".join(TRAINER_PACKAGES) + "\n", encoding="utf-8")
    return py


def _distractors() -> Path:
    """Look-alike words and sentences in many Kokoro voices (cached), plus the separate check sentences."""
    folder = _base() / "wake-train" / "distractors"
    check = _base() / "wake-train" / "check"
    if (folder / "done").is_file() and (check / "done").is_file():
        return folder
    _set("preparing", "Making practice examples (one time, a couple of minutes)...")
    import numpy as np

    from .. import kokoro_tts

    kokoro = kokoro_tts._Engine.get()
    voices = sorted(v for v in kokoro.get_voices() if v[:2] in ("af", "am", "bf", "bm"))
    rng = random.Random(7)

    def make(path: Path, text: str, voice: str) -> None:
        audio, rate = kokoro.create(text, voice=voice, speed=rng.uniform(0.85, 1.2), lang="en-us")
        a = np.asarray(audio, dtype=np.float32) * rng.uniform(0.4, 0.9)
        a = np.interp(np.linspace(0, len(a) - 1, int(len(a) * SR / rate)), np.arange(len(a)), a)
        _write_wav(path, (np.clip(a, -1, 1) * 32767).astype(np.int16).tobytes())

    for f, texts, per in ((folder, _DISTRACTOR_WORDS + _DISTRACTOR_SENTENCES, 3), (check, _CHECK_SENTENCES, 2)):
        shutil.rmtree(f, ignore_errors=True)
        f.mkdir(parents=True)
        n = 0
        for text in texts:
            for voice in rng.sample(voices, per):
                make(f / f"d{n:04d}.wav", text, voice)
                n += 1
        (f / "done").write_text("ok", encoding="utf-8")
    return folder


def _read(path: Path):
    import numpy as np

    with wave.open(str(path)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def _triggers(npz: Path, audio) -> int:
    from .heed_numpy import HeedDetector

    det = HeedDetector(npz)
    return sum(bool(det.step(audio[j:j + 1600], now=j / SR)["triggered"]) for j in range(0, len(audio) - 1600, 1600))


def _run() -> None:
    try:
        py = _trainer_python()
        distractors = _distractors()
        _set("training", "Learning how you say VYRSE (about a minute)...")
        work = _base() / "wake-train" / "job"
        shutil.rmtree(work, ignore_errors=True)
        (work / "positive").mkdir(parents=True)
        (work / "negative").mkdir(parents=True)
        takes = sorted(_folder("wake").glob("*.wav"))
        random.Random(len(takes)).shuffle(takes)
        held, train = takes[:HELD_OUT], takes[HELD_OUT:]
        for t in train:
            shutil.copy(t, work / "positive" / t.name)
        for t in list(_folder("other").glob("*.wav")) + list(distractors.glob("*.wav")):
            shutil.copy(t, work / "negative" / t.name)
        out = work / "model.npz"
        r = _run_cmd([str(py), str(Path(__file__).with_name("train_job.py")), str(work), str(out)], timeout=1800, cwd=work)
        if r.returncode != 0 or not out.is_file():
            raise RuntimeError(f"training failed: {(r.stderr or r.stdout).strip()[-300:]}")

        _set("checking", "Checking it on takes it didn't train on...")
        import numpy as np

        gap = np.zeros(SR, np.float32)
        caught = sum(_triggers(out, np.concatenate([gap, _read(t), gap])) > 0 for t in held)
        check = sorted((_base() / "wake-train" / "check").glob("*.wav"))
        speech = np.concatenate([x for p in check for x in (_read(p), gap)])
        false = _triggers(out, speech)
        minutes = len(speech) / SR / 60
        result = {"held_out_caught": caught, "held_out": len(held), "false_triggers": false, "speech_minutes": round(minutes, 1)}
        if caught < len(held) - 1 or false > 2:
            _set("failed", "It didn't learn well enough to replace the current one. Record again somewhere quiet, "
                           "saying VYRSE the way you normally would.", result=result)
            return
        models = _base() / "models"
        models.mkdir(parents=True, exist_ok=True)
        current = models / "wairz.npz"
        if current.is_file():
            shutil.copy(current, models / f"wairz.before-{time.strftime('%Y%m%d-%H%M%S')}.npz")
            for old in sorted(models.glob("wairz.before-*.npz"))[:-3]:
                old.unlink(missing_ok=True)
        shutil.copy(out, current)
        _set("done", f"Done: it caught {caught} of {len(held)} takes it hadn't heard and fired {false} time"
                     f"{'' if false == 1 else 's'} in {minutes:.1f} min of other speech. It's in use now.", result=result)
    except Exception as exc:  # noqa: BLE001 - reported to the user
        logger.exception("vyrse wake training failed")
        _set("failed", str(exc)[:300])


def describe() -> str:
    return json.dumps(status())
