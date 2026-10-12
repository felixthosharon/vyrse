"""Torch-free port of Heed's streaming wake-word detector (numpy only).

Mirrors `heed.infer.WakeWordDetector.step` exactly: causal high-pass + mains notches on new
audio, 1 s rolling window, energy/voice-band gate, peak normalisation, log-mel with cepstral mean
normalisation, the TinyWakeWordNet CNN, and the trigger rule (N consecutive raw probabilities
above threshold, refractory period). Weights come from scripts/export_wairz.py.

Equivalence with the original PyTorch detector is enforced by tests/test_heed_equivalence.py.
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Dict, Optional

import numpy as np

SAMPLE_RATE = 16000
HOP = 160
WIN = 400
N_FFT = 512
N_MELS = 40
BN_EPS = 1e-5


def sosfilt(sos: np.ndarray, x: np.ndarray, zi: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Cascade of biquads in transposed direct form II — the same recurrence as
    scipy.signal.sosfilt (zi shape (sections, 2)). Kept dependency-free on purpose: scipy's
    native libraries clash with other native audio stacks loaded in the Hermes process."""
    y = np.asarray(x, dtype=np.float64).copy()
    zf = np.array(zi, dtype=np.float64, copy=True)
    for s, (b0, b1, b2, _a0, a1, a2) in enumerate(np.asarray(sos, dtype=np.float64)):
        z0, z1 = zf[s]
        out = np.empty_like(y)
        for n, xn in enumerate(y.tolist()):
            yn = b0 * xn + z0
            z0 = b1 * xn - a1 * yn + z1
            z1 = b2 * xn - a2 * yn
            out[n] = yn
        zf[s] = (z0, z1)
        y = out
    return y, zf


def _mel_filterbank() -> np.ndarray:
    hz_to_mel = lambda hz: 2595.0 * math.log10(1.0 + hz / 700.0)  # noqa: E731
    mel_to_hz = lambda m: 700.0 * (10.0 ** (m / 2595.0) - 1.0)  # noqa: E731
    mel_pts = np.linspace(hz_to_mel(0.0), hz_to_mel(SAMPLE_RATE / 2), N_MELS + 2, dtype=np.float32)
    hz_pts = np.array([mel_to_hz(float(m)) for m in mel_pts], dtype=np.float32)
    freqs = np.linspace(0.0, SAMPLE_RATE / 2, N_FFT // 2 + 1, dtype=np.float32)
    fb = np.zeros((N_MELS, N_FFT // 2 + 1), dtype=np.float32)
    for m in range(N_MELS):
        left, center, right = hz_pts[m], hz_pts[m + 1], hz_pts[m + 2]
        rising = (freqs - left) / (center - left + 1e-9)
        falling = (right - freqs) / (right - center + 1e-9)
        fb[m] = np.clip(np.minimum(rising, falling), 0.0, None)
    return fb


_FB = _mel_filterbank()
# torch.hann_window(400) is periodic; torch.stft zero-pads it to n_fft, centred.
_WINDOW = np.zeros(N_FFT, dtype=np.float32)
_WINDOW[(N_FFT - WIN) // 2:(N_FFT - WIN) // 2 + WIN] = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(WIN) / WIN)).astype(np.float32)


def log_mel(audio: np.ndarray) -> np.ndarray:
    """(T,) float32 → (n_mels, frames) log-mel with per-clip mean removed (CMN)."""
    padded = np.pad(audio, N_FFT // 2, mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT)[::HOP] * _WINDOW
    spec = np.fft.rfft(frames, n=N_FFT, axis=-1)
    power = (spec.real ** 2 + spec.imag ** 2).astype(np.float32).T  # (bins, frames)
    out = np.log(np.maximum(_FB @ power, 1e-9))
    return out - out.mean(axis=-1, keepdims=True)


def _conv1d(x: np.ndarray, w: np.ndarray, stride: int, padding: int, groups: int = 1) -> np.ndarray:
    """x (C_in, T), w (C_out, C_in/groups, K) → (C_out, T_out); matches torch.nn.Conv1d (no bias)."""
    k = w.shape[-1]
    xp = np.pad(x, ((0, 0), (padding, padding)))
    windows = np.lib.stride_tricks.sliding_window_view(xp, k, axis=1)[:, ::stride, :]  # (C_in, T_out, K)
    if groups == 1:
        return np.einsum("ctk,ock->ot", windows, w, optimize=True)
    # depthwise: one filter per channel
    return np.einsum("ctk,ck->ct", windows, w[:, 0, :], optimize=True)


class TinyWakeWordNetNumpy:
    def __init__(self, weights: Dict[str, np.ndarray]) -> None:
        self.w = weights

    def _bn(self, x: np.ndarray, name: str) -> np.ndarray:
        w = self.w
        scale = w[f"{name}.weight"] / np.sqrt(w[f"{name}.running_var"] + BN_EPS)
        return (x - w[f"{name}.running_mean"][:, None]) * scale[:, None] + w[f"{name}.bias"][:, None]

    def logit(self, mel: np.ndarray) -> float:
        w = self.w
        x = self._bn(mel, "input_norm")
        x = np.maximum(self._bn(_conv1d(x, w["stem.0.weight"], stride=2, padding=2), "stem.1"), 0.0)
        i = 0
        while f"blocks.{i}.depth.weight" in w:
            stride = 2 if i == 1 else 1  # TinyWakeWordNet: block n_blocks//2 (=1) has stride 2
            dw = w[f"blocks.{i}.depth.weight"]
            x = _conv1d(x, dw, stride=stride, padding=dw.shape[-1] // 2, groups=dw.shape[0])
            x = _conv1d(x, w[f"blocks.{i}.point.weight"], stride=1, padding=0)
            x = np.maximum(self._bn(x, f"blocks.{i}.bn"), 0.0)
            i += 1
        pooled = x.mean(axis=-1)
        return float(pooled @ w["classifier.weight"][0] + w["classifier.bias"][0])


class EnergyGate:
    """Heed's gate: RMS above -55 dBFS and ≥15 % of energy in 100–7000 Hz."""

    def __init__(self, energy_dbfs: float = -55.0, voice_band_min: float = 0.15) -> None:
        self.energy_threshold = 10 ** (energy_dbfs / 20.0)
        self.voice_band_min = voice_band_min

    def __call__(self, audio: np.ndarray) -> bool:
        n = audio.size
        if n < 64:
            return False
        rms = float(np.sqrt(np.mean(audio.astype(np.float32) ** 2)))
        if rms < self.energy_threshold:
            return False
        window = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / n)).astype(np.float32)
        mag = np.abs(np.fft.rfft(audio * window)) ** 2
        freqs = np.fft.rfftfreq(n, d=1.0 / SAMPLE_RATE)
        total = max(float(mag.sum()), 1e-12)
        band = float(mag[(freqs >= 100.0) & (freqs <= 7000.0)].sum()) / total
        return band >= self.voice_band_min


class HeedDetector:
    """Streaming wake-word detector; feed 16 kHz mono float32 chunks to `step`."""

    def __init__(self, npz_path: str | Path, *, threshold: Optional[float] = None, consecutive_frames: int = 2,
                 refractory_seconds: float = 0.7, ema_alpha: float = 0.5) -> None:
        data = np.load(str(npz_path))
        meta = json.loads(bytes(data["meta"]).decode("utf-8"))
        self.phrase = meta.get("phrase", "")
        self.threshold = float(meta["threshold"] if threshold is None else threshold)
        self.net = TinyWakeWordNetNumpy({k[2:]: data[k] for k in data.files if k.startswith("w.")})
        self._sos = [data[f"sos.{i}"] for i in range(meta["n_sos"])]
        self._zi_unit = [data[f"zi.{i}"] for i in range(meta["n_sos"])]
        self._zi: list = [None] * len(self._sos)
        self.buffer = np.zeros(SAMPLE_RATE, dtype=np.float32)
        self.gate = EnergyGate()
        self.consecutive_frames = consecutive_frames
        self.refractory_seconds = refractory_seconds
        self.ema_alpha = ema_alpha
        self.ema = 0.0
        self.above = 0
        self.last_trigger = -1e9

    def _highpass(self, chunk: np.ndarray) -> np.ndarray:
        x = chunk.astype(np.float64).ravel()
        for i, sos in enumerate(self._sos):
            if self._zi[i] is None:
                self._zi[i] = self._zi_unit[i] * x[0]
            x, self._zi[i] = sosfilt(sos, x, self._zi[i])
        return x.astype(np.float32)

    def step(self, chunk: np.ndarray, now: Optional[float] = None) -> Dict[str, float | bool]:
        now = time.monotonic() if now is None else now
        filtered = self._highpass(chunk)
        n = filtered.size
        self.buffer = filtered[-SAMPLE_RATE:].copy() if n >= SAMPLE_RATE else np.concatenate([self.buffer[n:], filtered])
        if not self.gate(self.buffer):
            self.ema *= 0.5
            self.above = 0
            return {"prob": 0.0, "ema": self.ema, "triggered": False, "gated": True}
        peak = float(np.abs(self.buffer).max())
        normalized = self.buffer * (10 ** (-3.0 / 20.0) / max(peak, 1e-9)) if peak >= 1e-6 else self.buffer
        prob = 1.0 / (1.0 + math.exp(-self.net.logit(log_mel(normalized.astype(np.float32)))))
        self.ema = self.ema_alpha * prob + (1 - self.ema_alpha) * self.ema
        self.above = self.above + 1 if prob > self.threshold else 0
        triggered = False
        if self.above >= self.consecutive_frames and now - self.last_trigger > self.refractory_seconds:
            triggered, self.last_trigger, self.above = True, now, 0
        return {"prob": prob, "ema": self.ema, "triggered": triggered, "gated": False}
