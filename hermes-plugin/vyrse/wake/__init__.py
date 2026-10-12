"""The "wairz" wake word as a Hermes wake engine (`wake_word.provider: heed`).

Hermes owns the wake-word lifecycle (wake.start/feed/stop, wake.detected events, client capture);
this only supplies the detector. Requires Hermes patch 0002 (`register_wake_engine`).

Config (`wake_word.heed` in Hermes config.yaml): model (default %HERMES_HOME%/vyrse/models/wairz.npz),
threshold (default: the trained 0.666), consecutive_frames (2), refractory_seconds (0.7).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict


def _vyrse_dir() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / "vyrse"


def _model_path(cfg: Dict[str, Any]) -> Path:
    section = cfg.get("heed") if isinstance(cfg.get("heed"), dict) else {}
    return Path(section.get("model") or _vyrse_dir() / "models" / "wairz.npz")


class HeedEngine:
    """Hermes `_Engine` contract: `frame_length`, `process(int16 frame) -> bool`, `close()`."""

    frame_length = 1600  # 100 ms at 16 kHz, the hop Heed was tuned with
    last_match = None

    def __init__(self, cfg: Dict[str, Any]) -> None:
        from .heed_numpy import HeedDetector

        section = cfg.get("heed") if isinstance(cfg.get("heed"), dict) else {}
        self._detector = HeedDetector(
            _model_path(cfg),
            threshold=section.get("threshold"),
            consecutive_frames=int(section.get("consecutive_frames", 2)),
            refractory_seconds=float(section.get("refractory_seconds", 0.7)),
        )
        self.phrase = self._detector.phrase

    @classmethod
    def available(cls) -> bool:
        try:
            from tools.wake_word import load_wake_word_config
            return _model_path(load_wake_word_config()).is_file()
        except Exception:
            return False

    def process(self, frame) -> bool:
        import numpy as np
        audio = np.asarray(frame, dtype=np.int16).astype(np.float32) / 32768.0
        return bool(self._detector.step(audio)["triggered"])

    def close(self) -> None:
        self._detector = None


def register(ctx) -> None:  # noqa: ARG001 - kept symmetric with the plugin's register()
    try:
        from tools import wake_word
    except Exception:
        return
    if not hasattr(wake_word, "register_wake_engine"):
        import logging
        logging.getLogger(__name__).warning(
            "vyrse: Hermes lacks register_wake_engine (patch 0002); the 'wairz' wake word is unavailable")
        return
    wake_word.register_wake_engine("heed", HeedEngine)
