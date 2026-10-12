"""Fixture for app/src/lib/voice/__tests__/heed.test.ts: a few clips streamed through the reference
numpy detector, with its per-frame probabilities, so the phone's TypeScript port can be checked
against it. Run with the Hermes venv from the repo root:

    python scripts/make_heed_fixture.py <dir of synthetic wake clips>
"""
import base64
import json
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, "hermes-plugin")
from vyrse.wake.heed_numpy import HeedDetector  # noqa: E402

NPZ = Path("assets/voice/wake/vyrse-generic.npz")
# Synthetic voices only (scripts/wake/make_generic_data.py held-out clips): no real person's voice in the repo.
CLIPS_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("heldout")
clips = {f"synthetic_{i}": p for i, p in enumerate(sorted(CLIPS_DIR.glob("*.wav"))[:3])}
out = {"clips": []}
for name, p in clips.items():
    with wave.open(str(p)) as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    pcm = np.concatenate([np.zeros(8000, np.int16), pcm, np.zeros(8000, np.int16)])
    pcm = pcm[: len(pcm) // 1600 * 1600]
    audio = pcm.astype(np.float32) / 32768.0
    det = HeedDetector(NPZ)
    probs, triggered = [], []
    for j in range(0, len(audio), 1600):
        r = det.step(audio[j: j + 1600], now=j / 16000)
        probs.append(round(float(r["prob"]), 6))
        triggered.append(bool(r["triggered"]))
    out["clips"].append({"name": name, "pcm": base64.b64encode(pcm.tobytes()).decode(), "probs": probs, "triggered": triggered})
dst = Path("app/src/lib/voice/__tests__/fixtures/heed-equivalence.json")
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(json.dumps(out), encoding="utf-8")
print("wrote", dst, [(c["name"], max(c["probs"]), any(c["triggered"])) for c in out["clips"]])
