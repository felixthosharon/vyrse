"""Export the wake-word .npz (scripts/export_wairz.py) to JSON for the phone app's on-device detector
(app/src/lib/voice/heed.ts). Run with the Hermes venv:

    python scripts/export_wake_json.py assets/voice/vyrse/vyrse.npz app/public/wake/vyrse.json
"""
import json
import sys

import numpy as np


def main(src: str, dst: str) -> None:
    data = np.load(src)
    meta = json.loads(bytes(data["meta"]).decode("utf-8"))
    out = {"meta": meta, "weights": {}, "sos": [], "zi": []}
    for k in data.files:
        if k.startswith("w."):
            a = data[k].astype(np.float32)
            out["weights"][k[2:]] = {"shape": list(a.shape), "data": [round(float(v), 7) for v in a.ravel()]}
    for i in range(meta["n_sos"]):
        out["sos"].append([float(v) for v in data[f"sos.{i}"].ravel()])
        out["zi"].append([float(v) for v in data[f"zi.{i}"].ravel()])
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {dst}: {len(out['weights'])} tensors, threshold {meta['threshold']}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
