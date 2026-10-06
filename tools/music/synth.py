"""Instrument synthesis, effects and mixing for the radio songs (pure numpy/scipy).

Every instrument is a function returning a mono float array that starts at the note's onset
(it may ring past `dur`). Randomness always comes from a passed-in `np.random.Generator`, so a
song renders the same every time.
"""

from __future__ import annotations

import re

import numpy as np
from scipy import signal
from scipy.ndimage import minimum_filter1d

SR = 44100
TAU = 2 * np.pi

# ---- pitch -----------------------------------------------------------------------------------

_NOTE = re.compile(r"^([A-Ga-g])([#b]?)(-?\d)$")
_SEMI = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def midi(name: str | int) -> int:
    """'C#4' / 'Eb5' / 60 -> MIDI note number (A4 = 69)."""
    if isinstance(name, (int, np.integer)):
        return int(name)
    m = _NOTE.match(name)
    if not m:
        raise ValueError(f"bad note {name!r}")
    letter, acc, octave = m.groups()
    n = _SEMI[letter.upper()] + (1 if acc == "#" else -1 if acc == "b" else 0)
    return 12 * (int(octave) + 1) + n


def hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


# ---- helpers ---------------------------------------------------------------------------------


def secs(n: int) -> np.ndarray:
    return np.arange(n) / SR


def ramp_env(n: int, attack: float, release_at: float, release: float) -> np.ndarray:
    """Linear attack, hold, then an exponential-ish release starting at `release_at` seconds."""
    t = secs(n)
    e = np.minimum(1.0, t / max(attack, 1e-4))
    rel = np.clip((t - release_at) / max(release, 1e-4), 0, None)
    return e * np.exp(-4.6 * rel) * (rel < 1.5)


def sos_filter(x: np.ndarray, kind: str, freq, order: int = 2) -> np.ndarray:
    freq = np.clip(np.asarray(freq, dtype=float), 20, SR / 2 * 0.95)
    sos = signal.butter(order, freq, btype=kind, fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=-1)


def noise(n: int, rng: np.random.Generator) -> np.ndarray:
    return rng.uniform(-1, 1, n)


def softclip(x: np.ndarray, drive: float = 1.0) -> np.ndarray:
    return np.tanh(x * drive) / np.tanh(drive)


def osc_phase(freq: np.ndarray) -> np.ndarray:
    """Phase (radians) of an oscillator following a per-sample frequency track."""
    return TAU * np.cumsum(freq) / SR


def vibrato_track(n: int, f: float, rate: float, cents: float, delay: float, rng, scoop_cents: float = 0.0, scoop_t: float = 0.05) -> np.ndarray:
    """Frequency track: optional scoop up into the note, then vibrato fading in after `delay`."""
    t = secs(n)
    depth = cents * np.clip((t - delay) / 0.25, 0, 1)
    ph = rng.uniform(0, TAU)
    c = depth * np.sin(TAU * rate * t + ph)
    if scoop_cents:
        c = c + scoop_cents * np.exp(-t / max(scoop_t, 1e-3))
    return f * 2 ** (c / 1200)


# ---- plucked strings -------------------------------------------------------------------------


_PLUCKS: dict = {}


def pluck(f, dur, vel=1.0, rng=None, bright=0.5, decay=1.2, pos=0.15, damp=0.06, inharm=0.00015, body=None, freq_track=None, tail=0.4):
    """Plucked string by additive synthesis: pluck-position comb, faster decay up the series.

    `freq_track` (per-sample Hz, len = samples) bends/vibratos the note (electric guitar).
    Plain notes are cached (strummed parts repeat the same few thousands of times).
    """
    if freq_track is None and body is None:
        dur = round(dur, 2)
        key = (round(f, 3), dur, bright, decay, pos, damp, inharm, tail)
        if key not in _PLUCKS:
            _PLUCKS[key] = _pluck(f, dur, 1.0, np.random.default_rng(abs(hash(key)) % 2**32), bright, decay, pos, damp, inharm, None, None, tail)
        return vel * _PLUCKS[key]
    return _pluck(f, dur, vel, rng, bright, decay, pos, damp, inharm, body, freq_track, tail)


def _pluck(f, dur, vel, rng, bright, decay, pos, damp, inharm, body, freq_track, tail):
    if damp is not None:
        tail = min(tail, damp * 1.6 + 0.01)
    n = int((dur + tail) * SR)
    t = secs(n)
    fmax = float(np.max(freq_track)) if freq_track is not None else f
    K = int(max(1, min(48, 16000 / fmax)))
    k = np.arange(1, K + 1)
    amp = np.abs(np.sin(np.pi * k * pos)) / k ** (1.35 - 0.7 * bright) + 1e-4
    rates = (1 / decay) * (1 + 0.5 * (k - 1) * (1.25 - bright)) * (f / 220) ** 0.35
    stretch = np.sqrt(1 + inharm * k * k)
    phase = osc_phase(freq_track[:n] if freq_track is not None else np.full(n, f))
    if freq_track is not None and len(freq_track) < n:
        phase = osc_phase(np.concatenate([freq_track, np.full(n - len(freq_track), freq_track[-1])]))
    y = np.zeros(n)
    ph0 = rng.uniform(0, TAU, K) if rng is not None else np.zeros(K)
    for i in range(K):
        y += amp[i] * np.sin(phase * k[i] * stretch[i] + ph0[i]) * np.exp(-rates[i] * t)
    # Pick attack: a 2 ms ramp and a tiny burst of bright noise.
    y *= np.minimum(1, t / 0.002)
    if rng is not None:
        click = sos_filter(noise(min(n, int(0.008 * SR)), rng), "highpass", 2000) * np.exp(-np.arange(min(n, int(0.008 * SR))) / (0.0015 * SR))
        y[: len(click)] += 0.25 * bright * click * np.max(amp)
    # The player lets go (or palm-mutes) at the end of the note.
    if damp is not None:
        y *= ramp_env(n, 0.0, dur, damp)
    if body is not None:
        y = body(y)
    return vel * y / (np.sum(amp) * 0.6)


def strum(notes, dur, vel=1.0, rng=None, spread=0.012, up=False, **kw):
    """A strummed chord: strings hit one after another (low to high, or high to low on an upstroke)."""
    order = list(reversed(notes)) if up else list(notes)
    parts = []
    for i, m in enumerate(order):
        delay = i * spread * (0.8 + 0.4 * rng.random())
        v = vel * (0.85 + 0.3 * rng.random()) * (0.8 if up and i > 2 else 1)
        parts.append((delay, pluck(hz(midi(m)), max(0.02, dur - delay), v, rng, **kw)))
    n = max(int(d * SR) + len(p) for d, p in parts)
    y = np.zeros(n)
    for d, p in parts:
        s = int(d * SR)
        y[s : s + len(p)] += p
    return y / np.sqrt(len(notes))


# ---- winds -----------------------------------------------------------------------------------


def flute(f, dur, vel=1.0, rng=None, breath=0.12, harmonics=(1, 0.22, 0.09, 0.035), vib_cents=14, vib_rate=5.4, attack=0.035, chiff=0.5, scoop=-25, tail=0.15):
    """Quena-like end-blown flute: a near-sine with breath noise, a chiff and late vibrato."""
    n = int((dur + tail) * SR)
    ft = vibrato_track(n, f, vib_rate, vib_cents, delay=min(0.18, dur * 0.4), rng=rng, scoop_cents=scoop, scoop_t=0.03)
    ph = osc_phase(ft) + rng.uniform(0, TAU)
    y = sum(a * np.sin((i + 1) * ph) for i, a in enumerate(harmonics))
    env = ramp_env(n, attack, dur, 0.06)
    # Breath swells a little through long notes.
    env *= 1 + 0.08 * np.clip(secs(n) / max(dur, 0.1), 0, 1)
    nz = noise(n, rng)
    air = sos_filter(nz, "bandpass", [f * 0.9, min(f * 4, 15000)], 1) * breath
    hiss = sos_filter(nz, "highpass", 5000) * breath * 0.35
    ch = sos_filter(noise(n, rng), "bandpass", [f * 1.5, min(f * 6, 16000)], 1) * chiff * np.exp(-secs(n) / 0.025)
    return vel * (y * env + (air + hiss) * env + ch * np.minimum(1, secs(n) / 0.004))


def panpipe(f, dur, vel=1.0, rng=None, **kw):
    """Rondador / panpipe: purer tone, breathier, a hard chiff, little vibrato."""
    args = dict(breath=0.2, harmonics=(1, 0.08, 0.05), vib_cents=6, vib_rate=4.8, attack=0.02, chiff=0.9, scoop=-10)
    args.update(kw)
    return flute(f, dur, vel, rng, **args)


# ---- keys ------------------------------------------------------------------------------------


def organ(f, dur, vel=1.0, rng=None, vib_cents=10, vib_rate=6.2, bright=1.0, tail=0.05):
    """Farfisa-style combo organ: a buzzy, reedy, slightly vibrato'd tone, instant on/off."""
    n = int((dur + tail) * SR)
    ft = vibrato_track(n, f, vib_rate, vib_cents, delay=0.0, rng=rng)
    ph = osc_phase(ft)
    K = int(max(1, min(24, 12000 / f)))
    y = np.zeros(n)
    for k in range(1, K + 1):
        # Odd partials stronger (square-ish reed) with a dash of even ones.
        a = (1.0 if k % 2 else 0.45) / k ** (1.05 - 0.25 * bright)
        y += a * np.sin(k * ph)
    env = ramp_env(n, 0.004, dur, 0.02)
    return vel * 0.45 * y * env


def pad(f, dur, vel=1.0, rng=None, voices=5, detune=12, cutoff=2400, attack=0.25, release=0.5):
    """Detuned-saw synth pad, low-passed."""
    n = int((dur + release) * SR)
    y = np.zeros(n)
    for v in range(voices):
        c = detune * (v - (voices - 1) / 2) / max(1, (voices - 1) / 2)
        fv = f * 2 ** (c / 1200)
        ph = (fv * secs(n) + rng.random()) % 1.0
        y += 2 * ph - 1
    y = sos_filter(y / voices, "lowpass", cutoff)
    return vel * y * ramp_env(n, attack, dur, release / 2)


def synth_pluck(f, dur, vel=1.0, rng=None, cutoff=(5000, 500), decay=0.35, tail=0.3, square=0.4):
    """Bright plucky lead (saw + square) with a falling filter envelope."""
    n = int((dur + tail) * SR)
    t = secs(n)
    ph = (f * t + rng.random()) % 1.0
    sq = np.where(((f * 1.003 * t) % 1.0) < 0.5, 1.0, -1.0)
    y = (1 - square) * (2 * ph - 1) + square * sq
    # Time-varying low-pass, approximated by crossfading a bright and a dark version.
    bright = sos_filter(y, "lowpass", cutoff[0])
    dark = sos_filter(y, "lowpass", cutoff[1])
    w = np.exp(-t / (decay * 0.35))
    y = w * bright + (1 - w) * dark
    env = np.exp(-t / decay) * ramp_env(n, 0.002, dur, 0.05)
    return vel * 0.6 * y * env


def lead_voice(f, dur, vel=1.0, rng=None, glide_from=None, cutoff=3200, vib_cents=18):
    """A singing synth lead (stands in for a voice): saw+triangle, glide, vibrato, formant-ish band."""
    n = int((dur + 0.15) * SR)
    ft = vibrato_track(n, f, 5.6, vib_cents, delay=0.2, rng=rng)
    if glide_from is not None:
        g = np.exp(-secs(n) / 0.04)
        ft = ft * (glide_from / f) ** g
    ph = osc_phase(ft) / TAU
    saw = 2 * (ph % 1.0) - 1
    tri = 2 * np.abs(saw) - 1
    y = 0.55 * saw + 0.45 * tri
    y = sos_filter(y, "lowpass", cutoff) + 0.35 * sos_filter(y, "bandpass", [900, 1600], 1)
    return vel * 0.5 * y * ramp_env(n, 0.015, dur, 0.06)


# ---- basses ----------------------------------------------------------------------------------


def bass(f, dur, vel=1.0, rng=None, decay=0.9, tone=0.35, tail=0.12):
    """Round electric/acoustic bass: fundamental, a bit of 2nd and 3rd, plucked envelope."""
    n = int((dur + tail) * SR)
    t = secs(n)
    ph = TAU * f * t + rng.uniform(0, TAU)
    y = np.sin(ph) + tone * 0.6 * np.sin(2 * ph) * np.exp(-t / 0.25) + tone * 0.3 * np.sin(3 * ph) * np.exp(-t / 0.12)
    env = np.exp(-t / decay) * ramp_env(n, 0.004, dur, 0.04)
    thump = sos_filter(noise(n, rng), "lowpass", 900) * np.exp(-t / 0.01) * 0.3
    return vel * softclip((y + thump) * env, 1.2)


def sub808(f, dur, vel=1.0, rng=None, glide_from=None, drive=1.6, tail=0.08):
    """808-style sub: a sine with a short pitch kick and gentle saturation (harmonics for phones)."""
    n = int((dur + tail) * SR)
    t = secs(n)
    ft = f * (1 + 0.6 * np.exp(-t / 0.012))
    if glide_from is not None:
        ft = ft * (glide_from / f) ** np.exp(-t / 0.06)
    y = np.sin(osc_phase(ft))
    env = ramp_env(n, 0.003, dur, 0.05)
    return vel * softclip(y * env, drive) * 0.9


# ---- drums & percussion ----------------------------------------------------------------------


def kick(vel=1.0, rng=None, f0=50, f1=140, decay=0.35, click=0.4, drive=2.0, sweep=0.035):
    n = int((decay * 3) * SR)
    t = secs(n)
    ft = f0 + (f1 - f0) * np.exp(-t / sweep)
    y = np.sin(osc_phase(ft)) * np.exp(-t / decay)
    c = sos_filter(noise(n, rng), "bandpass", [1500, 6000]) * np.exp(-t / 0.004) * click
    return vel * softclip(y + c, drive)


def bombo(vel=1.0, rng=None, open_=True):
    """Andean bombo (big, deep, goat-skin bass drum): a boomy membrane, a soft-mallet thud."""
    decay = 0.42 if open_ else 0.14
    n = int(1.2 * SR)
    t = secs(n)
    ft = 62 + 40 * np.exp(-t / 0.05)
    y = np.sin(osc_phase(ft)) * np.exp(-t / decay)
    y += 0.35 * np.sin(osc_phase(ft * 1.58)) * np.exp(-t / (decay * 0.5))
    thud = sos_filter(noise(n, rng), "lowpass", 400) * np.exp(-t / 0.03) * 0.9
    skin = sos_filter(noise(n, rng), "bandpass", [150, 900]) * np.exp(-t / 0.012) * 0.6
    return vel * softclip(y + thud + skin, 1.4)


def wood(vel=1.0, rng=None, freq=1100, decay=0.025):
    """A stick on a wooden rim/shell (bombo rim, timbal cáscara)."""
    n = int(0.15 * SR)
    t = secs(n)
    tone = np.sin(TAU * freq * t) * np.exp(-t / decay) + 0.5 * np.sin(TAU * freq * 2.37 * t) * np.exp(-t / (decay * 0.6))
    nz = sos_filter(noise(n, rng), "bandpass", [freq * 0.8, freq * 4]) * np.exp(-t / 0.006)
    return vel * 0.6 * (tone + nz)


def snare(vel=1.0, rng=None, tone_f=190, decay=0.16, snappy=0.9, bright=7000):
    n = int(0.6 * SR)
    t = secs(n)
    body = np.sin(osc_phase(tone_f * (1 + 0.3 * np.exp(-t / 0.01)))) * np.exp(-t / (decay * 0.5))
    nz = sos_filter(noise(n, rng), "bandpass", [1200, bright]) * np.exp(-t / decay) * snappy
    return vel * softclip(0.6 * body + nz, 1.5)


def rimshot(vel=1.0, rng=None):
    """Tight reggaeton snare/rim: short snare plus a high, woody click."""
    n = int(0.3 * SR)
    t = secs(n)
    click = np.sin(TAU * 1750 * t) * np.exp(-t / 0.012) + 0.6 * np.sin(TAU * 520 * t) * np.exp(-t / 0.02)
    nz = sos_filter(noise(n, rng), "bandpass", [1800, 9000]) * np.exp(-t / 0.045)
    return vel * 0.8 * softclip(click * 0.7 + nz, 1.3)


def clap(vel=1.0, rng=None, decay=0.12):
    n = int(0.5 * SR)
    t = secs(n)
    env = np.zeros(n)
    for d in (0.0, 0.009, 0.02, 0.028):
        s = int(d * SR)
        env[s:] += np.exp(-(t[: n - s]) / 0.004)
    env += np.exp(-np.clip(t - 0.03, 0, None) / decay) * (t >= 0.03) * 0.8
    return vel * 0.9 * sos_filter(noise(n, rng), "bandpass", [900, 5000]) * env


def hat(vel=1.0, rng=None, open_=False):
    """Hi-hat: six detuned square waves (808-style metal) plus noise, high-passed."""
    decay = 0.28 if open_ else 0.035
    n = int((decay * 4 + 0.02) * SR)
    t = secs(n)
    metal = sum(np.sign(np.sin(TAU * f * t)) for f in (205.3, 304.4, 369.6, 522.7, 540.0, 800.0))
    y = 0.4 * metal / 6 + noise(n, rng)
    y = sos_filter(y, "highpass", 7000, 4) * np.exp(-t / decay)
    return vel * 0.7 * y


def shaker(vel=1.0, rng=None, length=0.07, center=5500):
    """Seed rattle (chajchas) / shaker: a short, soft-attack burst of band-passed noise."""
    n = int((length * 2) * SR)
    t = secs(n)
    env = np.minimum(1, t / (length * 0.35)) * np.exp(-np.clip(t - length * 0.35, 0, None) / (length * 0.3))
    return vel * 0.6 * sos_filter(noise(n, rng), "bandpass", [center * 0.5, min(center * 2, 18000)]) * env


def guiro(vel=1.0, rng=None, length=0.12, rate=95.0):
    """Güiro scrape: a train of tiny clicks (the ridges) under a scrape-shaped envelope."""
    n = int((length + 0.03) * SR)
    t = secs(n)
    clicks = np.zeros(n)
    period = SR / rate
    pos = 0.0
    while pos < length * SR:
        i = int(pos)
        clicks[i] = 1.0 * (0.7 + 0.6 * rng.random())
        pos += period * (0.9 + 0.2 * rng.random())
    ridge = np.exp(-np.arange(int(0.004 * SR)) / (0.0008 * SR))
    y = np.convolve(clicks, ridge)[:n] * noise(n, rng)
    y = sos_filter(y, "bandpass", [2200, 7500])
    env = np.minimum(1, t / 0.01) * np.where(t < length, 1.0, np.exp(-(t - length) / 0.008))
    return vel * 1.6 * y * env


def conga(vel=1.0, rng=None, f=210, stroke="open"):
    n = int(0.6 * SR)
    t = secs(n)
    decay = {"open": 0.18, "mute": 0.05, "slap": 0.06}[stroke]
    ft = f * (1 + 0.12 * np.exp(-t / 0.015))
    y = np.sin(osc_phase(ft)) * np.exp(-t / decay) + 0.3 * np.sin(osc_phase(ft * 1.5)) * np.exp(-t / (decay * 0.5))
    slap = sos_filter(noise(n, rng), "bandpass", [1500, 6000]) * np.exp(-t / (0.02 if stroke == "slap" else 0.005))
    return vel * 0.7 * (y + slap * (1.6 if stroke == "slap" else 0.4))


def timbal(vel=1.0, rng=None, f=520, decay=0.35):
    """Timbal: thin metal-shelled drum, ringing inharmonic overtones and a sharp stick."""
    n = int((decay * 3) * SR)
    t = secs(n)
    y = sum(a * np.sin(TAU * f * r * t) * np.exp(-t / (decay * d)) for r, a, d in ((1, 1, 1), (1.51, 0.5, 0.7), (1.99, 0.35, 0.5), (2.44, 0.25, 0.4), (3.1, 0.15, 0.3)))
    stick = sos_filter(noise(n, rng), "highpass", 3000) * np.exp(-t / 0.006) * 0.8
    return vel * 0.55 * (y + stick)


def cymbal(vel=1.0, rng=None, decay=1.6):
    n = int(decay * 3 * SR)
    t = secs(n)
    metal = sum(np.sign(np.sin(TAU * f * t)) for f in (305, 437, 573, 829, 1001, 1222))
    y = sos_filter(noise(n, rng) + 0.2 * metal / 6, "highpass", 4500, 2)
    return vel * 0.45 * y * np.exp(-t / decay) * np.minimum(1, t / 0.002)


def riser(length, vel=1.0, rng=None, lo=300, hi=9000):
    """Noise swell sweeping up (a build into a section)."""
    n = int(length * SR)
    t = secs(n) / length
    x = noise(n, rng)
    # Sweep a band-pass by filtering short overlapping blocks.
    out = np.zeros(n)
    block = 2048
    win = np.hanning(block * 2)
    for s in range(0, n, block):
        seg = x[s : s + block * 2]
        if len(seg) < 16:
            break
        c = lo * (hi / lo) ** (t[s] if s < n else 1)
        y = sos_filter(seg, "bandpass", [c * 0.7, min(c * 1.4, 20000)])
        out[s : s + len(seg)] += y * win[: len(seg)]
    return vel * 0.5 * out * t**2


# ---- effects ---------------------------------------------------------------------------------


def reverb_ir(decay: float, rng: np.random.Generator, predelay=0.012, damp=6000, early=True) -> np.ndarray:
    """Stereo impulse response: decaying noise, darker as it fades, plus a few early reflections."""
    n = int((decay * 1.4 + predelay) * SR)
    t = secs(n)
    ir = np.zeros((2, n))
    for ch in range(2):
        nz = noise(n, rng)
        env = np.exp(-6.9 * t / decay) * np.minimum(1, t / 0.008)
        bright = sos_filter(nz, "lowpass", damp)
        dark = sos_filter(nz, "lowpass", damp / 4)
        mix = np.exp(-t / (decay * 0.3))
        ir[ch] = (mix * bright + (1 - mix) * dark) * env
        if early:
            for _ in range(8):
                d = rng.uniform(0.004, 0.05)
                ir[ch, int(d * SR)] += rng.uniform(0.2, 0.5) * (1 - d * 10)
    s = int(predelay * SR)
    ir = np.concatenate([np.zeros((2, s)), ir[:, : n - s]], axis=1)
    return ir / np.sqrt(np.sum(ir**2) / 2)


def convolve_stereo(x: np.ndarray, ir: np.ndarray) -> np.ndarray:
    """x: (2, n) dry send; returns (2, n) wet (tail cut to n)."""
    n = x.shape[1]
    mono = x.mean(axis=0)
    side = (x[0] - x[1]) / 2
    out = np.zeros_like(x)
    for ch in range(2):
        out[ch] = signal.fftconvolve(mono + (side if ch == 0 else -side) * 0.5, ir[ch])[:n]
    return out


def delay(x: np.ndarray, time: float, feedback=0.35, repeats=6, lowpass=3500, pingpong=True) -> np.ndarray:
    """Feedback echo built from summed delayed copies (each darker), optionally ping-ponging."""
    d = int(time * SR)
    out = np.zeros_like(x)
    cur = x.copy()
    for r in range(1, repeats + 1):
        cur = sos_filter(cur, "lowpass", lowpass, 1) * feedback
        if pingpong:
            cur = cur[::-1]
        out[:, d * r :] += cur[:, : x.shape[1] - d * r]
    return out


def spring(x: np.ndarray, rng: np.random.Generator, decay=1.4) -> np.ndarray:
    """Surf-guitar spring reverb: a drippy, band-limited, chirpy tail."""
    n = int(decay * 1.2 * SR)
    t = secs(n)
    ir = np.zeros((2, n))
    for ch in range(2):
        nz = noise(n, rng)
        # The "boing": a chirp sweeping down repeating every ~35 ms, under the noise wash.
        chirp = np.sin(TAU * (2500 * ((t % 0.033) / 0.033) ** 0.5) * (t % 0.033)) * 0.5
        ir[ch] = sos_filter(nz + chirp, "bandpass", [400, 4500]) * np.exp(-6.9 * t / decay)
    ir /= np.sqrt(np.sum(ir**2) / 2)
    return convolve_stereo(x, ir)


def tremolo(y: np.ndarray, rate: float, depth: float) -> np.ndarray:
    return y * (1 - depth / 2 + depth / 2 * np.sin(TAU * rate * secs(len(y))))


# ---- mixing ----------------------------------------------------------------------------------


class Track:
    """A stereo stem: notes are dropped in at a time with a gain and pan; sends go to buses."""

    def __init__(self, length_s: float, name: str):
        self.name = name
        self.buf = np.zeros((2, int(length_s * SR)))

    def add(self, y: np.ndarray, at: float, gain=1.0, pan=0.0):
        s = int(round(at * SR))
        if s >= self.buf.shape[1] or s + len(y) <= 0:
            return
        if s < 0:
            y, s = y[-s:], 0
        y = y[: self.buf.shape[1] - s]
        # Constant-power pan.
        a = (pan + 1) * np.pi / 4
        self.buf[0, s : s + len(y)] += y * gain * np.cos(a)
        self.buf[1, s : s + len(y)] += y * gain * np.sin(a)


def block_gain(x: np.ndarray, threshold_db: float, ratio: float, attack: float, release: float, block=64, rms=True) -> np.ndarray:
    """Compressor gain curve (per sample) from a block-rate detector."""
    mono = np.max(np.abs(x), axis=0) if not rms else np.sqrt(np.mean(x**2, axis=0))
    nb = len(mono) // block + 1
    pad = np.zeros(nb * block)
    pad[: len(mono)] = mono
    lvl = np.sqrt(np.mean(pad.reshape(nb, block) ** 2, axis=1)) if rms else pad.reshape(nb, block).max(axis=1)
    db = 20 * np.log10(lvl + 1e-9)
    over = np.maximum(0, db - threshold_db)
    target = -over * (1 - 1 / ratio)
    a = np.exp(-block / (attack * SR))
    r = np.exp(-block / (release * SR))
    g = np.zeros(nb)
    cur = 0.0
    for i in range(nb):
        c = a if target[i] < cur else r
        cur = c * cur + (1 - c) * target[i]
        g[i] = cur
    centers = (np.arange(nb) + 0.5) * block
    return 10 ** (np.interp(np.arange(x.shape[1]), centers, g) / 20)


def limiter(x: np.ndarray, ceiling_db=-1.5, release=0.08, block=32) -> np.ndarray:
    """Look-ahead peak limiter: block gains, min over neighbours (look-ahead), smooth release."""
    c = 10 ** (ceiling_db / 20)
    peak = np.max(np.abs(x), axis=0)
    nb = len(peak) // block + 1
    pad = np.zeros(nb * block)
    pad[: len(peak)] = peak
    need = np.minimum(1.0, c / (pad.reshape(nb, block).max(axis=1) + 1e-12))
    need = minimum_filter1d(need, 3)
    r = np.exp(-block / (release * SR))
    g = np.empty(nb)
    cur = 1.0
    for i in range(nb):
        cur = need[i] if need[i] < cur else r * cur + (1 - r) * need[i]
        g[i] = cur
    gain = np.interp(np.arange(x.shape[1]), (np.arange(nb) + 0.5) * block, g)
    return np.clip(x * gain, -c, c)
