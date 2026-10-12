"""Train a VYRSE wake-word model with the Heed trainer (CPU is fine: ~1 minute).

    python scripts/wake/train.py <data_dir> <out.pt> [aug_positives_per_real]

<data_dir> has positive/ and negative/ folders of 16 kHz mono WAVs. Export for VYRSE afterwards with
scripts/export_wairz.py (-> .npz for the PC) and scripts/export_wake_json.py (-> .json for the phone).
Needs a Python with `heed-wakeword` and CPU torch (VYRSE's in-app training sets one up for you).
"""
import sys
from pathlib import Path

from heed.trainer import TrainerConfig, train_wake_word

data = Path(sys.argv[1])
out = Path(sys.argv[2])
per_real = int(sys.argv[3]) if len(sys.argv) > 3 else 60
cfg = TrainerConfig(phrase="vyrse", epochs=40, aug_positives_per_real=per_real, aug_negatives_per_real=6, device="cpu")
art = train_wake_word(data / "positive", data / "negative", out, phrase="vyrse", cfg=cfg)
print(f"RESULT threshold={art.threshold:.3f} tpr={art.user_voice_tpr:.2f} fpr={art.user_voice_fpr:.2f}")
