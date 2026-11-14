"""VYRSE alarm tones, synthesised: short patterns that loop without a seam (the app loops alarm.ogg and swells it).
Usage: python synth_alarm.py <out-dir>   ->  alarm-pulse.wav, alarm-rise.wav, alarm-beacon.wav (stereo, 48 kHz).
Convert the chosen one:  ffmpeg -i alarm-pulse.wav -c:a libopus -b:a 96k app/public/sounds/alarm.ogg

Original patterns in the style of a modern phone alarm: clean mallet and glass tones, no bells, no buzzer."""
import sys
import wave
from pathlib import Path

import numpy as np

SR = 48000
OUT = Path(sys.argv[1])


def mallet(f, dur=0.9, bright=0.35):
    """A soft mallet on glass: fundamental, a quiet octave and a fast-fading 4th harmonic for the 'tok'."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    attack = np.clip(t / 0.004, 0, 1)
    y = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.22)
    y += 0.30 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t / 0.12)
    y += bright * np.sin(2 * np.pi * 4 * f * t) * np.exp(-t / 0.035)
    return y * attack


def glass(f, dur=1.4):
    """A rounder, longer tone: two slightly detuned sines and a soft fifth above."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    attack = np.clip(t / 0.012, 0, 1) ** 1.5
    y = np.sin(2 * np.pi * f * t) + 0.6 * np.sin(2 * np.pi * f * 1.003 * t)
    y += 0.18 * np.sin(2 * np.pi * 3 * f * t) * np.exp(-t / 0.10)
    return y * attack * np.exp(-t / 0.38)


def beep(f, dur=0.13):
    """A clean, rounded beep (raised-cosine edges, so no click)."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    edge = int(SR * 0.012)
    e = np.ones(n)
    e[:edge] = 0.5 * (1 - np.cos(np.linspace(0, np.pi, edge)))
    e[-edge:] = 0.5 * (1 + np.cos(np.linspace(0, np.pi, edge)))
    return (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t) + 0.08 * np.sin(2 * np.pi * 3 * f * t)) * e


def loop(length_s, events):
    """Place (time, samples, gain, pan) events on a loop; anything past the end wraps to the start (seamless)."""
    n = int(SR * length_s)
    out = np.zeros((n, 2))
    for at, y, gain, pan in events:
        idx = (int(SR * at) + np.arange(len(y))) % n
        np.add.at(out[:, 0], idx, y * gain * (1 - 0.35 * max(pan, 0)))
        np.add.at(out[:, 1], idx, y * gain * (1 + 0.35 * min(pan, 0)))
    return out


def air(x, delay_s=0.11, feedback=0.28, wet=0.16):
    """A little space: a short wrapped echo, opposite ears, so the loop still joins up."""
    n = len(x)
    d = int(SR * delay_s)
    wetsig = np.zeros_like(x)
    tap = x[:, ::-1].copy()
    for k in range(1, 5):
        wetsig += np.roll(tap, d * k, axis=0) * (feedback ** (k - 1))
        tap = tap[:, ::-1]
    return x + wet * wetsig[:n]


def save(name, x, peak=0.5):
    x = x / (np.max(np.abs(x)) + 1e-9) * peak
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


# Note frequencies (equal temperament).
A4 = 440.0
note = lambda semis: A4 * 2 ** (semis / 12)
D5, Fs5, A5, B5, D6, E6, Fs6, A6 = note(5), note(9), note(12), note(14), note(17), note(19), note(21), note(24)

# 1. Pulse: a quick four-note mallet figure, said twice, then a breath. Awake and clear without being harsh.
step = 0.105
figure = [A5, E6, A5, Fs6]
events = []
for rep, start in enumerate((0.0, 0.56)):
    for i, f in enumerate(figure):
        events.append((start + i * step, mallet(f), 1.0 if i in (1, 3) else 0.8, -0.4 if i % 2 else 0.4))
save("alarm-pulse", air(loop(1.9, events)))

# 2. Rise: a calm glass arpeggio climbing five notes, then a rest. The gentle wake-up.
events = [(i * 0.17, glass(f), 0.9 + 0.05 * i, (-0.5, 0.2, -0.2, 0.5, 0.0)[i]) for i, f in enumerate((D5, Fs5, A5, D6, Fs6))]
events.append((0.17 * 5 + 0.12, glass(A6, 1.2), 0.7, 0.0))
save("alarm-rise", air(loop(2.6, events), delay_s=0.16, wet=0.22))

# 3. Beacon: the classic digital alarm, cleaned up: two rounded double-beeps, then a rest.
events = []
for start in (0.0, 0.52):
    events.append((start, beep(B5), 1.0, 0.0))
    events.append((start + 0.17, beep(B5), 1.0, 0.0))
    events.append((start + 0.17, beep(Fs6, 0.13), 0.35, 0.0))
save("alarm-beacon", air(loop(1.7, events), delay_s=0.09, wet=0.08))
