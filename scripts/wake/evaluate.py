"""Evaluate a VYRSE wake model the way the app runs it (100 ms frames, 2 frames over threshold, refractory):
detection rate on positive clips, and false triggers on a stream of other speech.

    python scripts/wake/evaluate.py <model.npz> <positives_dir> <negative_speech_dir> [thresholds...]
"""
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "hermes-plugin"))
from vyrse.wake.heed_numpy import HeedDetector  # noqa: E402

SR = 16000


def read(p: Path) -> np.ndarray:
    with wave.open(str(p)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def triggers(npz: Path, audio: np.ndarray, threshold: float) -> int:
    det = HeedDetector(npz, threshold=threshold)
    return sum(bool(det.step(audio[j:j + 1600], now=j / SR)["triggered"]) for j in range(0, len(audio) - 1600, 1600))


npz, pos_dir, neg_dir = (Path(a) for a in sys.argv[1:4])
thresholds = [float(t) for t in sys.argv[4:]] or [0.5, 0.6, 0.7]
gap = np.zeros(SR, np.float32)
positives = [np.concatenate([gap, read(p), gap]) for p in sorted(pos_dir.glob("*.wav"))]
negative_stream = np.concatenate([x for p in sorted(neg_dir.glob("*.wav")) for x in (read(p), gap)])
minutes = len(negative_stream) / SR / 60
for t in thresholds:
    hit = sum(triggers(npz, a, t) > 0 for a in positives)
    false = triggers(npz, negative_stream, t)
    print(f"threshold {t:.2f}: caught {hit}/{len(positives)}  false triggers {false} in {minutes:.1f} min of speech")
