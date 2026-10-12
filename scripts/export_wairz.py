"""Export the trained Heed "wairz" wake-word model to a torch-free .npz for the vyrse plugin.

Run once with the Python environment that has `heed` + torch (the wairz training venv):
    resouces\\wairz\\.venv\\Scripts\\python.exe scripts\\export_wairz.py <model.pt> <out.npz>

The .npz holds the CNN weights (BatchNorm kept as running stats), the trained threshold and
phrase, and the exact high-pass/notch filter coefficients Heed uses, so the runtime detector
(hermes-plugin/vyrse/wake/heed_numpy.py) needs only numpy + scipy.
"""
import json
import sys

import numpy as np
import scipy.signal
from heed.audio import _hpf_coefficients, _notch_coefficients
from heed.trainer import load_model


def main(model_path: str, out_path: str) -> None:
    model, payload = load_model(model_path)
    model.eval()
    arrays = {f"w.{k}": v.detach().cpu().numpy().astype(np.float32) for k, v in model.state_dict().items()
              if not k.endswith("num_batches_tracked")}
    sos = [_hpf_coefficients(100.0, 16000, 8)] + [_notch_coefficients(f, 30.0, 16000) for f in (50.0, 60.0)]
    for i, s in enumerate(sos):
        arrays[f"sos.{i}"] = np.asarray(s, dtype=np.float64)
        arrays[f"zi.{i}"] = scipy.signal.sosfilt_zi(s)
    meta = {"phrase": payload.get("phrase", ""), "threshold": float(payload["threshold"]), "n_sos": len(sos),
            "format": "vyrse-heed-npz/1"}
    arrays["meta"] = np.frombuffer(json.dumps(meta).encode("utf-8"), dtype=np.uint8)
    np.savez(out_path, **arrays)
    print(f"exported {len(arrays)} arrays to {out_path}: {meta}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
