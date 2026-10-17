"""VYRSE UI sounds, synthesised: a glassy tap for buttons (tick, tick-soft) and a light two-note bell for replies.
Stereo 48 kHz WAVs; converted to Opus .ogg afterwards. Built to sit under a voice: soft attacks, no harsh highs."""
import sys
import wave
from pathlib import Path

import numpy as np

SR = 48000
OUT = Path(sys.argv[1])
rng = np.random.default_rng(7)


def env(n, attack_s, decay_s):
    t = np.arange(n) / SR
    a = np.clip(t / max(attack_s, 1e-4), 0, 1) ** 1.5
    return a * np.exp(-t / decay_s)


def partial(f, dur, attack, decay, amp=1.0, detune=0.0):
    n = int(SR * dur)
    t = np.arange(n) / SR
    y = amp * np.sin(2 * np.pi * f * (1 + detune) * t) * env(n, attack, decay)
    k = min(n, int(SR * 0.06))
    y[-k:] *= 0.5 * (1 + np.cos(np.linspace(0, np.pi, k)))  # no click where the note ends
    return y


def lowpass(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.zeros_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


def room(x, tail_s=0.35, wet=0.18, seed=1):
    """A small, soft room: exponentially decaying filtered noise as the impulse response, a little different per ear."""
    out = []
    for ch in range(2):
        r = np.random.default_rng(seed + ch)
        n = int(SR * tail_s)
        ir = r.standard_normal(n) * np.exp(-np.arange(n) / (SR * tail_s / 5.5))
        ir = lowpass(ir, 5200)
        ir[: int(SR * 0.008)] = 0  # pre-delay
        ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
        wetsig = np.convolve(x, ir)[: len(x) + n]
        wetsig = np.pad(wetsig, (0, len(x) + n - len(wetsig)))
        dry = np.concatenate([x, np.zeros(n)])
        out.append(dry + wet * wetsig)
    return np.stack(out, axis=1)


def pad(x, s):
    return np.concatenate([x, np.zeros(int(SR * s))])


def mix(*parts):
    n = max(len(p) for p in parts)
    y = np.zeros(n)
    for p in parts:
        y[: len(p)] += p
    return y


def write(name, stereo, peak_db):
    stereo = stereo / (np.max(np.abs(stereo)) + 1e-9) * 10 ** (peak_db / 20)
    fade = int(SR * 0.02)
    stereo[-fade:] *= np.linspace(1, 0, fade)[:, None]
    pcm = (stereo * 32767).astype(np.int16)
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def tap(base, soft=False):
    """Glass tap: two bright partials over a warm low body, a breath of noise for the touch."""
    d = 0.42
    body = partial(base / 4, d, 0.0015, 0.028, 0.55)
    glass = partial(base, d, 0.0008, 0.07 if not soft else 0.05, 0.75)
    glass2 = partial(base * 1.5, d, 0.0008, 0.045, 0.32, detune=0.0015)
    air = partial(base * 2.76, d, 0.0005, 0.018, 0.12)
    n = int(SR * d)
    touch = lowpass(rng.standard_normal(n) * env(n, 0.0003, 0.0035), 3800) * 0.35
    touch[int(SR * 0.05):] = 0
    x = mix(body, glass, glass2, air, touch)
    x = lowpass(x, 7000 if not soft else 5200)
    return room(x, 0.32, 0.22 if not soft else 0.16)


def bell(f, dur, amp):
    return mix(partial(f, dur, 0.006, 0.42, amp),
               partial(f * 2.0, dur, 0.004, 0.2, amp * 0.22, detune=0.002),
               partial(f * 2.76, dur, 0.003, 0.09, amp * 0.07),
               partial(f / 2, dur, 0.012, 0.25, amp * 0.18))


def reply():
    """Two light notes, a fifth apart, the second a breath later: 'here you go'."""
    d = 1.1
    a = bell(1318.5, d, 0.85)            # E6
    b = pad(np.zeros(int(SR * 0.085)), 0)
    b = np.concatenate([b, bell(1975.5, d - 0.085, 0.6)])  # B6
    shimmer = partial(3951, d, 0.03, 0.12, 0.04)
    x = lowpass(mix(a, b, shimmer), 6400)
    return room(x, 0.7, 0.3, seed=5)


OUT.mkdir(parents=True, exist_ok=True)
write("tick", tap(1760), -7.0)
write("tick-soft", tap(1318.5, soft=True), -8.5)
write("reply", reply(), -12.5)
print("ok")
