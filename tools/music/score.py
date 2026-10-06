"""Score notation, song timeline, mixdown and mastering shared by the three songs.

Melodies are written as text, one token per note: `NOTE.LEN` where LEN counts sixteenth notes,
NOTE is a pitch (`E5`, `F#4`, `Bb3`), a chord (`E4+G4+B4`) or `r` for a rest; a trailing `>`
accents the note. `|` marks bar lines and is checked, so a bar that doesn't add up is an error.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from synth import SR, Track, block_gain, convolve_stereo, limiter, midi, sos_filter

# ---- notation --------------------------------------------------------------------------------


@dataclass
class Note:
    start: int  # sixteenths from the phrase start
    length: int  # sixteenths
    pitches: list[int]  # empty for a rest
    accent: bool = False


def parse(text: str, bar_len: int = 16) -> list[Note]:
    notes: list[Note] = []
    pos = 0
    bar_start = 0
    for tok in text.split():
        if tok == "|":
            if pos - bar_start != bar_len:
                raise ValueError(f"bar ending at token {len(notes)} is {pos - bar_start}/16, not {bar_len}: ...{text[:80]}")
            bar_start = pos
            continue
        accent = tok.endswith(">")
        tok = tok.rstrip(">")
        name, _, ln = tok.rpartition(".")
        length = int(ln)
        pitches = [] if name == "r" else [midi(p) for p in name.split("+")]
        if pitches:
            notes.append(Note(pos, length, pitches, accent))
        pos += length
    if pos - bar_start not in (0, bar_len):
        raise ValueError(f"last bar is {pos - bar_start}/16, not {bar_len}: ...{text[-80:]}")
    return notes


def transpose(notes: list[Note], semis: int) -> list[Note]:
    return [Note(n.start, n.length, [p + semis for p in n.pitches], n.accent) for n in notes]


# ---- the song --------------------------------------------------------------------------------


@dataclass
class Bus:
    """A send effect: tracks send to it by name; `fx` turns the summed send into the wet signal."""

    fx: object
    gain: float = 1.0


@dataclass
class Song:
    title: str
    bpm: float
    bar_len: int  # sixteenths per bar
    bars: int
    seed: int
    tail: float = 3.0
    tracks: dict[str, Track] = field(default_factory=dict)
    mix: dict[str, dict] = field(default_factory=dict)

    def __post_init__(self):
        self.rng = np.random.default_rng(self.seed)
        self.length = self.at(self.bars) + self.tail

    @property
    def sixteenth(self) -> float:
        return 60 / self.bpm / 4

    def at(self, bar: float, step: float = 0) -> float:
        """Seconds at a bar (0-based) and sixteenth step."""
        return (bar * self.bar_len + step) * self.sixteenth

    def track(self, name: str, gain=1.0, pan=0.0, sends: dict[str, float] | None = None, post=None) -> Track:
        """A stem with its fader, pan, effect sends, and an optional insert (`post`: (2,n)->(2,n))."""
        if name not in self.tracks:
            self.tracks[name] = Track(self.length, name)
            self.mix[name] = dict(gain=gain, pan=pan, sends=sends or {}, post=post)
        return self.tracks[name]

    def hit(self, name: str, sound: np.ndarray, bar: float, step: float = 0, gain=1.0, pan=0.0, jitter=0.0):
        """One-shot (a drum hit, a riser) at a bar/step."""
        t = self.at(bar, step) + (self.rng.normal(0, jitter) if jitter else 0)
        self.tracks[name].add(sound, t, gain, pan)

    def play(self, name: str, inst, notes: list[Note], bar: float, gain=1.0, pan=0.0, jitter=0.0, vel_var=0.0, legato=1.0, accent=1.25, **kw):
        """Plays parsed notes on an instrument function `inst(freq, dur, vel, rng, **kw)` (chords note by note)."""
        from synth import hz

        for n in notes:
            dur = n.length * self.sixteenth * legato
            t = self.at(bar, n.start) + (self.rng.normal(0, jitter) if jitter else 0)
            v = (accent if n.accent else 1.0) * (1 + (self.rng.normal(0, vel_var) if vel_var else 0))
            for p in n.pitches:
                self.tracks[name].add(inst(hz(p), dur, v, self.rng, **kw), t, gain, pan)

    def render(self, buses: dict[str, Bus]) -> tuple[np.ndarray, dict[str, float]]:
        """Mixes every stem (post insert, fader) plus the effect buses; returns (stereo, stem levels dBFS)."""
        n = int(self.length * SR)
        out = np.zeros((2, n))
        sends = {k: np.zeros((2, n)) for k in buses}
        levels = {}
        for name, tr in self.tracks.items():
            m = self.mix[name]
            x = tr.buf[:, :n]
            if m["post"] is not None:
                x = m["post"](x)
            x = x * m["gain"]
            levels[name] = 10 * np.log10(np.mean(x**2) + 1e-12)
            out += x
            for bus, amt in m["sends"].items():
                sends[bus] += x * amt
        for k, b in buses.items():
            if np.any(sends[k]):
                wet = b.fx(sends[k])
                out += wet[:, :n] * b.gain
        return out, levels


def reverb_bus(ir: np.ndarray, highpass=200) -> object:
    return lambda x: convolve_stereo(sos_filter(x, "highpass", highpass), ir)


def sidechain(trigger_times: list[float], n: int, depth=0.5, release=0.18) -> np.ndarray:
    """A pumping gain curve that dips at each kick."""
    g = np.ones(n)
    t = np.arange(int(release * 4 * SR)) / SR
    dip = 1 - depth * np.exp(-t / release) * np.minimum(1, t / 0.004 + 0.5)
    for tt in trigger_times:
        s = int(tt * SR)
        if s >= n:
            continue
        e = min(n, s + len(dip))
        g[s:e] = np.minimum(g[s:e], dip[: e - s])
    return g


# ---- mastering -------------------------------------------------------------------------------


def lufs(x: np.ndarray) -> float:
    import pyloudnorm

    return pyloudnorm.Meter(SR).integrated_loudness(x.T)


def true_peak_db(x: np.ndarray) -> float:
    from scipy.signal import resample_poly

    up = resample_poly(x, 4, 1, axis=1)
    return 20 * np.log10(np.max(np.abs(up)) + 1e-12)


def master(x: np.ndarray, target_lufs=-16.0, ceiling_db=-1.5, glue=True) -> np.ndarray:
    """High-pass rumble, glue compression, then loudness to target under a peak ceiling."""
    x = sos_filter(x, "highpass", 28)
    if glue:
        x = x * block_gain(x, threshold_db=-18, ratio=2.0, attack=0.015, release=0.2)
    for _ in range(4):
        x = x * 10 ** ((target_lufs - lufs(x)) / 20)
        x = limiter(x, ceiling_db)
        if abs(lufs(x) - target_lufs) < 0.15:
            break
    return x


def fade_out(x: np.ndarray, seconds: float) -> np.ndarray:
    n = int(seconds * SR)
    x = x.copy()
    x[:, -n:] *= np.linspace(1, 0, n) ** 2
    return x


def encode_mp3(x: np.ndarray, path: str, kbps=64, out_rate=32000) -> int:
    """MP3 at a radio's quality: 64 kbps joint stereo at 32 kHz (the game plays it through a
    7.5 kHz cabin low-pass anyway), so all six songs fit in about 6 MB."""
    import lameenc

    enc = lameenc.Encoder()
    enc.set_bit_rate(kbps)
    enc.set_in_sample_rate(SR)
    enc.set_out_sample_rate(out_rate)
    enc.set_channels(2)
    enc.set_quality(2)
    pcm = (np.clip(x.T, -1, 1) * 32767).astype("<i2").tobytes()
    data = enc.encode(pcm) + enc.flush()
    with open(path, "wb") as f:
        f.write(data)
    return len(data)
