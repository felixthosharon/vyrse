"""Training data for VYRSE's public (speaker-independent) wake word: "VYRSE" spoken by many Kokoro voices,
plus distractor words and everyday sentences. No real person's voice is used.

Run with the Hermes venv (Kokoro lives in %HERMES_HOME%/vyrse/pylib):
    python scripts/wake/make_generic_data.py <out_dir>
Creates <out_dir>/positive, <out_dir>/negative and <out_dir>/heldout (voices kept out of training, for testing).
"""
import random
import sys
import wave
from pathlib import Path

import numpy as np

home = Path.home() / "AppData/Local/hermes"
sys.path.insert(0, str(home / "vyrse/pylib"))
import onnxruntime as ort  # noqa: E402
from kokoro_onnx import Kokoro  # noqa: E402

out = Path(sys.argv[1])
pos, neg, held = out / "positive", out / "negative", out / "heldout"
for d in (pos, neg, held):
    d.mkdir(parents=True, exist_ok=True)

session = ort.InferenceSession(str(home / "vyrse/models/kokoro/kokoro-v1.0.onnx"), providers=["CPUExecutionProvider"])
kokoro = Kokoro.from_session(session, str(home / "vyrse/models/kokoro/voices-v1.0.bin"))
voices = sorted(v for v in kokoro.get_voices() if v[:2] in ("af", "am", "bf", "bm"))
random.seed(5)
random.shuffle(voices)
held_voices, train_voices = voices[:4], voices[4:]


def save(path: Path, text: str, voice: str, speed: float, gain: float) -> None:
    a, sr = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
    a = np.asarray(a, dtype=np.float32) * gain
    a = np.interp(np.linspace(0, len(a) - 1, int(len(a) * 16000 / sr)), np.arange(len(a)), a)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes((np.clip(a, -1, 1) * 32767).astype(np.int16).tobytes())


# How people say it: "vyse" rhyming with wise, sometimes a softer "vize", sometimes read as "verse"-ish.
spellings = ["Vyse.", "Vize.", "Vyrse.", "Vyse!", "Vyse?", "Vies."]
n = 0
for v in train_voices:
    for text in random.sample(spellings, 4):
        save(pos / f"p{n:04d}.wav", text, v, random.uniform(0.8, 1.25), random.uniform(0.4, 0.95))
        n += 1
h = 0
for v in held_voices:
    for text in spellings[:3]:
        save(held / f"h{h:03d}.wav", text, v, 1.0, 0.8)
        h += 1

words = [
    "nice", "rice", "price", "vice", "verse", "first", "worse", "nurse", "voice", "vibe", "fries", "eyes", "size",
    "hi", "hey", "okay", "yes", "no", "five", "my", "white", "wife", "wise", "why", "while", "wives", "versus",
    "Alexa", "Siri", "hello", "right", "light", "sure", "bye", "fire", "wire", "mice", "slice", "twice", "advice",
    "device", "surprise", "rise", "guys", "buys", "flies", "skies", "prize", "despise", "revise",
]
sentences = [
    "Why is the server down again?", "That was a wise move.", "Five more minutes, I'm almost done.",
    "Give me some advice on this.", "The device keeps disconnecting.", "What a surprise, honestly.",
    "Open Chrome and check my email.", "What time is it right now?", "Play some music please.",
    "I'll be there in a while.", "The price went up again.", "Nice, that worked first try.",
    "Turn the volume down a bit.", "Set a timer for ten minutes.", "Let's go, one more game.",
    "Can you read me that again?", "I think it's twice as fast now.", "The white one looks better.",
]
m = 0
for text in words:
    for v in random.sample(train_voices, 3):
        save(neg / f"w{m:04d}.wav", text, v, random.uniform(0.85, 1.2), random.uniform(0.4, 0.9))
        m += 1
for text in sentences:
    for v in random.sample(train_voices, 4):
        save(neg / f"s{m:04d}.wav", text, v, random.uniform(0.9, 1.2), random.uniform(0.4, 0.9))
        m += 1
print(f"positives {n}, negatives {m}, held-out {h} (voices {held_voices})")
