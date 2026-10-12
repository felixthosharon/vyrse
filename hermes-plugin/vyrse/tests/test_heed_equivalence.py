"""Gate for the torch-free wake-word port: the numpy detector must match Heed's PyTorch detector
on every recorded clip (positives and negatives), streamed in 100 ms chunks exactly as live audio.

Needs the wairz training venv (heed + torch). Run:
    resouces\\wairz\\.venv\\Scripts\\python.exe hermes-plugin\\vyrse\\tests\\test_heed_equivalence.py <wairz_dir> <wairz.npz>
"""
import sys
from pathlib import Path

import numpy as np
import torch
from heed.audio import load_wav
from heed.infer import WakeWordDetector

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wake"))
from heed_numpy import HeedDetector  # noqa: E402

CHUNK = 1600  # 100 ms at 16 kHz, as in `heed listen`


def stream(detector, audio: np.ndarray):
    out = []
    for i, start in enumerate(range(0, len(audio) - CHUNK + 1, CHUNK)):
        out.append(detector.step(audio[start:start + CHUNK], now=i * 0.1))
    return out


def main(wairz_dir: str, npz: str) -> int:
    root = Path(wairz_dir)
    clips = sorted((root / "positive").glob("*.wav")) + sorted((root / "negative").glob("*.wav"))
    worst, mismatched_triggers, mismatched_gates = 0.0, 0, 0
    detected = {"positive": 0, "negative": 0}
    silence = np.zeros(8000, dtype=np.float32)
    for clip in clips:
        audio = load_wav(clip).numpy().astype(np.float32)
        # pad with silence both sides so the word passes fully through the 1 s window
        audio = np.concatenate([silence, audio, silence, silence])
        ref = stream(WakeWordDetector(root / "model.pt"), torch.from_numpy(audio))
        port = stream(HeedDetector(npz), audio)
        for r, p in zip(ref, port):
            worst = max(worst, abs(float(r["prob"]) - float(p["prob"])))
            mismatched_gates += int(bool(r["gated"]) != bool(p["gated"]))
        ref_hit, port_hit = any(r["triggered"] for r in ref), any(p["triggered"] for p in port)
        mismatched_triggers += int(ref_hit != port_hit)
        detected[clip.parent.name] += int(port_hit)
    n_pos = len(list((root / "positive").glob("*.wav")))
    n_neg = len(clips) - n_pos
    print(f"clips={len(clips)} max|Δprob|={worst:.2e} gate mismatches={mismatched_gates} trigger mismatches={mismatched_triggers}")
    print(f"port detections: positives {detected['positive']}/{n_pos}, negatives {detected['negative']}/{n_neg}")
    ok = worst < 1e-3 and mismatched_triggers == 0 and mismatched_gates == 0
    print("EQUIVALENT" if ok else "NOT EQUIVALENT")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
