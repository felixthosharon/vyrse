"""Runs inside VYRSE's wake-word trainer environment (heed-wakeword + CPU torch), started by training.py:

    python train_job.py <data_dir> <out.npz>

Trains on <data_dir>/positive and <data_dir>/negative and exports the model as VYRSE's torch-free .npz
(the same format scripts/export_wairz.py writes). Prints "RESULT {json}" on success.
"""
import json
import sys
from pathlib import Path

import numpy as np
import scipy.signal
from heed.audio import _hpf_coefficients, _notch_coefficients
from heed.trainer import TrainerConfig, load_model, train_wake_word

data, out = Path(sys.argv[1]), Path(sys.argv[2])
cfg = TrainerConfig(phrase="vyrse", epochs=40, aug_positives_per_real=60, aug_negatives_per_real=6, device="cpu")
art = train_wake_word(data / "positive", data / "negative", out.with_suffix(".pt"), phrase="vyrse", cfg=cfg,
                      log_fn=lambda msg: print(msg, flush=True))

model, payload = load_model(str(out.with_suffix(".pt")))
model.eval()
arrays = {f"w.{k}": v.detach().cpu().numpy().astype(np.float32) for k, v in model.state_dict().items()
          if not k.endswith("num_batches_tracked")}
sos = [_hpf_coefficients(100.0, 16000, 8)] + [_notch_coefficients(f, 30.0, 16000) for f in (50.0, 60.0)]
for i, s in enumerate(sos):
    arrays[f"sos.{i}"] = np.asarray(s, dtype=np.float64)
    arrays[f"zi.{i}"] = scipy.signal.sosfilt_zi(s)
meta = {"phrase": "vyrse", "threshold": float(payload["threshold"]), "n_sos": len(sos),
        "format": "vyrse-heed-npz/1", "speaker": "trained in VYRSE"}
arrays["meta"] = np.frombuffer(json.dumps(meta).encode("utf-8"), dtype=np.uint8)
np.savez(out, **arrays)
print("RESULT " + json.dumps({"threshold": meta["threshold"], "tpr": art.user_voice_tpr, "fpr": art.user_voice_fpr}), flush=True)
