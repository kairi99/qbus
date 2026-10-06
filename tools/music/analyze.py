"""Objective checks on a rendered mix (we can't listen from here): loudness, peaks, spectrum
balance, tempo from the onsets, the average rhythm per sixteenth of the bar, and the key.

    python3 tools/music/analyze.py tools/music/out/chicha.wav 100 16
"""

from __future__ import annotations

import numpy as np
from scipy import signal

from synth import SR

BANDS = [("sub <60", 20, 60), ("bass 60-250", 60, 250), ("low-mid 250-1k", 250, 1000), ("mid 1-4k", 1000, 4000), ("high 4-10k", 4000, 10000), ("air >10k", 10000, 20000)]
NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
# Krumhansl-Kessler key profiles.
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def stft_mag(mono: np.ndarray, n_fft=2048, hop=512):
    f, t, z = signal.stft(mono, SR, nperseg=n_fft, noverlap=n_fft - hop, boundary=None, padded=False)
    return f, t, np.abs(z)


def onset_env(mag: np.ndarray) -> np.ndarray:
    flux = np.maximum(0, np.diff(np.log1p(100 * mag), axis=1)).sum(axis=0)
    return np.concatenate([[0], flux])


def tempo(mono: np.ndarray, lo=70, hi=180) -> list[tuple[float, float]]:
    """Best BPM candidates from the onset envelope's autocorrelation."""
    hop = 512
    _, _, mag = stft_mag(mono, hop=hop)
    env = onset_env(mag)
    env = env - env.mean()
    ac = np.correlate(env, env, "full")[len(env) - 1 :]
    fps = SR / hop
    cands = []
    for lag in range(int(fps * 60 / hi), int(fps * 60 / lo) + 1):
        cands.append((60 * fps / lag, ac[lag]))
    cands.sort(key=lambda c: -c[1])
    out = []
    for bpm, v in cands:
        if all(abs(bpm - b) > 3 for b, _ in out):
            out.append((bpm, v / ac[0]))
        if len(out) == 3:
            break
    return out


def grid(mono: np.ndarray, bpm: float, bar_len: int, band: tuple[float, float]) -> np.ndarray:
    """Average onset strength at each sixteenth of the bar, in one frequency band."""
    hop = 256
    f, _, mag = stft_mag(mono, n_fft=1024, hop=hop)
    sel = (f >= band[0]) & (f < band[1])
    env = onset_env(mag[sel])
    fps = SR / hop
    six = 60 / bpm / 4
    steps = np.zeros(bar_len)
    count = np.zeros(bar_len)
    i = 0
    while True:
        t = i * six
        k = int(round(t * fps))
        if k + 2 >= len(env):
            break
        steps[i % bar_len] += env[k : k + 3].max()
        count[i % bar_len] += 1
        i += 1
    v = steps / np.maximum(1, count)
    return v / (v.max() + 1e-12)


def key(mono: np.ndarray) -> str:
    f, _, mag = stft_mag(mono, n_fft=8192, hop=4096)
    sel = (f > 80) & (f < 2000)
    pcs = np.round(12 * np.log2(f[sel] / 440) + 69).astype(int) % 12
    chroma = np.zeros(12)
    np.add.at(chroma, pcs, (mag[sel] ** 2).sum(axis=1))
    best = max(((np.corrcoef(np.roll(prof, k), chroma)[0, 1], f"{NAMES[k]} {mode}") for prof, mode in ((MAJOR, "major"), (MINOR, "minor")) for k in range(12)))
    top = " ".join(NAMES[i] for i in np.argsort(-chroma)[:5])
    return f"{best[1]} (r={best[0]:.2f}; strongest pitch classes {top})"


def bars(v: np.ndarray, bar_len: int) -> str:
    beat = 4
    return " ".join(("#" if x > 0.66 else "+" if x > 0.4 else "." if x > 0.2 else "_") + (" " if (i + 1) % beat == 0 and i + 1 < bar_len else "") for i, x in enumerate(v)).replace("  ", " ")


def report(x: np.ndarray, song=None) -> None:
    from score import lufs, true_peak_db

    mono = x.mean(axis=0)
    peak = 20 * np.log10(np.max(np.abs(x)) + 1e-12)
    rms = 10 * np.log10(np.mean(x**2) + 1e-12)
    clipped = int(np.sum(np.abs(x) >= 0.999))
    print(f"loudness {lufs(x):.1f} LUFS, peak {peak:.1f} dBFS, true peak {true_peak_db(x):.1f} dBTP, crest {peak - rms:.1f} dB, clipped samples {clipped}")
    spec = np.abs(np.fft.rfft(mono)) ** 2
    fr = np.fft.rfftfreq(len(mono), 1 / SR)
    tot = spec[(fr > 20) & (fr < 20000)].sum()
    print("spectrum: " + ", ".join(f"{n} {100 * spec[(fr >= a) & (fr < b)].sum() / tot:.0f}%" for n, a, b in BANDS) + f"; centroid {np.sum(fr * spec) / np.sum(spec):.0f} Hz")
    print("tempo candidates: " + ", ".join(f"{b:.1f} bpm ({v:.2f})" for b, v in tempo(mono)))
    print(f"key: {key(mono)}")
    l, r = x
    print(f"stereo: L/R correlation {np.corrcoef(l, r)[0, 1]:.2f}, side/mid {10 * np.log10(np.mean((l - r) ** 2) / np.mean((l + r) ** 2)):.1f} dB")
    if song is not None:
        print(f"rhythm per sixteenth ({song.bar_len} per bar; # strong, + medium, . weak, _ none):")
        for name, band in (("low <150 Hz", (20, 150)), ("high >3 kHz", (3000, 16000))):
            print(f"  {name:12} {bars(grid(mono, song.bpm, song.bar_len, band), song.bar_len)}")


if __name__ == "__main__":
    import sys
    import wave

    with wave.open(sys.argv[1]) as w:
        data = np.frombuffer(w.readframes(w.getnframes()), "<i2").reshape(-1, 2).T / 32768
    report(data)
    print(tempo(data.mean(axis=0)))
