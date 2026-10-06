"""Reggaeton: "Bajo la Lluvia de las Cuatro" (original). 4/4 at 90 bpm, B minor, Bm-G-Em-F# loop.

The romantic, old-school one, against the first song's dark F minor club track: a slower
i-VI-iv-V loop (the major V, with its A# leading tone, gives the romantic pull), a "sung" synth lead with a harmony a third below in the hook, a tine
electric piano (instead of plucks and nylon guitar) and string pads, a real snare doubling the
rim on the dembow, timbal fills between sections (the early-2000s sound), and Quito's
four-o'clock rain falling over the intro, the bridge and the outro.

Form: intro (rain, filtered e-piano, riser) - hook - verse - hook (+ harmony) - bridge (D-A-G-F#,
no drums but the rain) - hook (+ countermelody) - outro (rain), final hit.
Drums: kick on every beat, snare/rim on the dembow sixteenths (3+3+2: steps 4, 7, 12, 15 of 16).
"""

from __future__ import annotations

import numpy as np

import synth as s
from score import Bus, Note, Song, parse, reverb_bus, sidechain
from synth import SR, hz, midi

BAR = 16
LOOP = ["Bm", "G", "Em", "F#"]
CHORDS = {
    "Bm": ["B3", "D4", "F#4", "B4"],
    "G": ["B3", "D4", "G4", "B4"],
    "Em": ["G3", "B3", "E4", "G4"],
    "F#": ["A#3", "C#4", "F#4", "A#4"],
    "D": ["A3", "D4", "F#4", "A4"],
    "A": ["A3", "C#4", "E4", "A4"],
}
SUB = {"Bm": "B1", "G": "G1", "Em": "E2", "F#": "F#1", "D": "D2", "A": "A1"}

HOOK = """
B4.3> D5.3 F#5.2 F#5.2 E5.2 D5.4 | G5.3 F#5.3 D5.2 B4.8 |
E5.3 G5.3 B5.2 B5.2 A5.2 G5.2 E5.2 | F#5.3 E5.3 C#5.2 A#4.8 |
B4.3> D5.3 F#5.2 F#5.2 E5.2 F#5.2 A5.2 | B5.3 A5.3 G5.2 D5.8 |
E5.3 F#5.3 G5.2 E5.2 B4.2 E5.4 | C#5.4 A#4.4 F#4.8 |
"""
VERSE = """
r.2 B4.2 B4.2 D5.2 B4.2 A4.2 B4.4 | r.2 B4.2 D5.2 G5.2 F#5.4 D5.4 |
r.2 E5.2 E5.2 G5.2 F#5.2 E5.2 B4.4 | C#5.4 A#4.4 F#4.8 |
r.2 B4.2 B4.2 D5.2 F#5.2 E5.2 D5.4 | r.2 D5.2 G5.2 F#5.2 D5.4 B4.4 |
r.2 G5.2 F#5.2 E5.2 D5.2 E5.2 G5.4 | F#5.4 E5.4 C#5.8 |
"""
BRIDGE = """
A4.4 D5.4 F#5.6 E5.2 | E5.4 C#5.4 A4.8 | B4.4 D5.4 G5.6 F#5.2 | A#4.4 C#5.4 F#5.8 |
"""
BRIDGE_CH = ["D", "A", "G", "F#"]
COUNTER = """
B5.8 A5.8 | G5.8 D5.8 | E5.8 G5.8 | F#5.16 |
D6.8 B5.8 | B5.8 G5.8 | G5.8 E5.8 | A#5.8 C#6.8 |
"""

# B natural minor, and with A# (the harmonic minor's leading tone) over the F# chord: the
# scales for the hook's harmony a third below.
SCALE = [11, 1, 2, 4, 6, 7, 9]
SCALE_V = [11, 1, 2, 4, 6, 7, 10]


def third_below(m: int, scale=SCALE) -> int:
    pc = m % 12
    if pc not in scale:
        return m - 3
    i = scale.index(pc)
    return m - (pc - scale[(i - 2) % 7]) % 12


def harmony(notes: list[Note], chords: list[str]) -> list[Note]:
    return [Note(x.start, x.length, [third_below(p, SCALE_V if chords[(x.start // BAR) % len(chords)] == "F#" else SCALE) for p in x.pitches], x.accent) for x in notes]


def rain(length: float, rng: np.random.Generator, drops=26.0) -> np.ndarray:
    """Steady rain: a soft wash of filtered noise plus random drops (tiny falling pings)."""
    n = int(length * SR)
    wash = s.sos_filter(s.noise(n, rng), "bandpass", [700, 7000])
    # A slow swell so the wash isn't static.
    wash *= 0.75 + 0.25 * np.sin(s.TAU * 0.11 * s.secs(n) + rng.uniform(0, s.TAU))
    y = 0.25 * wash
    d = int(0.03 * SR)
    td = s.secs(d)
    for _ in range(int(drops * length)):
        at = int(rng.uniform(0, n - d))
        f = rng.uniform(1800, 5200)
        ping = np.sin(s.TAU * np.cumsum(f * (1 - 0.35 * td / 0.03)) / SR) * np.exp(-td / 0.006)
        y[at : at + d] += rng.uniform(0.05, 0.25) * ping
    fade = min(n // 2, int(1.5 * SR))
    y[:fade] *= np.linspace(0, 1, fade)
    y[-fade:] *= np.linspace(1, 0, fade)
    return y


def build() -> tuple[Song, dict]:
    song = Song("Bajo la Lluvia de las Cuatro", bpm=90, bar_len=BAR, bars=44, seed=2005, tail=3.5)
    rng = song.rng
    hall = s.reverb_ir(2.6, rng, predelay=0.03, damp=6500)
    plate = s.reverb_ir(1.1, rng, predelay=0.006, damp=8000)
    quarter = 60 / song.bpm
    buses = {
        "hall": Bus(reverb_bus(hall, 250), 0.45),
        "plate": Bus(reverb_bus(plate, 400), 0.35),
        "delay": Bus(lambda x: s.delay(x, quarter, feedback=0.35, repeats=4, lowpass=3500), 0.35),
    }
    kicks: list[float] = []
    n = int(song.length * SR)
    pump = lambda depth: (lambda x: x * sidechain(kicks, n, depth=depth, release=0.2)[: x.shape[1]])

    song.track("kick", gain=0.5)
    song.track("sub", gain=0.34)
    song.track("snare", gain=0.75, sends={"plate": 0.3})
    song.track("rim", gain=1.1, pan=0.08, sends={"plate": 0.2})
    song.track("hats", gain=0.95, pan=-0.25)
    song.track("timbal", gain=0.6, pan=0.2, sends={"plate": 0.25})
    song.track("epiano", gain=0.9, pan=0.2, sends={"hall": 0.25, "delay": 0.1}, post=pump(0.3))
    song.track("strings", gain=0.3, pan=-0.15, sends={"hall": 0.5}, post=pump(0.35))
    song.track("lead", gain=1.1, pan=-0.05, sends={"hall": 0.3, "delay": 0.22})
    song.track("harmony", gain=0.6, pan=0.25, sends={"hall": 0.35, "delay": 0.2})
    song.track("fx", gain=0.6, sends={"hall": 0.3})
    song.track("rain", gain=0.5)

    def drums(bar, kick=True, snare=True, hats=True):
        if kick:
            for step in (0, 4, 8, 12):
                song.hit("kick", s.kick(1.0, rng, f0=50, f1=130, decay=0.3, click=0.35, drive=1.8), bar, step)
                kicks.append(song.at(bar, step))
        if snare:
            for step in (3, 6, 11, 14):
                song.hit("rim", s.rimshot(0.9, rng), bar, step)
                # The snare doubles the rim, harder on the second hit of each tresillo.
                song.hit("snare", s.snare(0.9 if step in (6, 14) else 0.6, rng, tone_f=210, decay=0.13, snappy=0.8), bar, step)
        if hats:
            for step in range(0, 16, 2):
                song.hit("hats", s.hat(0.8 if step % 4 == 2 else 0.5, rng), bar, step)
            if bar % 4 == 3:
                song.hit("hats", s.hat(0.6, rng, open_=True), bar, 14)

    def timbal_fill(bar, start=12):
        # The old-school timbal run into the next section.
        for i, step in enumerate(range(start, 16)):
            for sub_step in (0, 0.5):
                song.hit("timbal", s.timbal(0.5 + 0.06 * i, rng, f=620 if i < (16 - start) / 2 else 440, decay=0.2), bar, step + sub_step)

    def sub(bar, chord, vel=1.0):
        p = midi(SUB[chord])
        for step, ln, d in ((0, 6, 0), (6, 2, 0), (8, 6, 0), (14, 2, 7)):
            song.tracks["sub"].add(s.sub808(hz(p + d), ln * song.sixteenth * 0.9, vel, rng), song.at(bar, step))

    def keys(bar, chords, vel=1.0):
        # E-piano: the chord on 1, re-struck on the tresillo's "and", a top-note arpeggio between.
        for i, c in enumerate(chords):
            notes = [midi(p) for p in CHORDS[c]]
            for step, ln, v in ((0, 6, 1.0), (6, 2, 0.6), (8, 8, 0.85)):
                for p in notes:
                    song.tracks["epiano"].add(s.epiano(hz(p), ln * song.sixteenth, vel * v * 0.6, rng), song.at(bar + i, step) + rng.normal(0, 0.002))
            for step, k in ((10, 1), (12, 2), (14, 3)):
                song.tracks["epiano"].add(s.epiano(hz(notes[k] + 12), song.sixteenth * 2, vel * 0.4, rng), song.at(bar + i, step))

    def strings(bar, chords, vel=1.0, cutoff=1800):
        for i, c in enumerate(chords):
            for p in CHORDS[c]:
                song.tracks["strings"].add(s.pad(hz(midi(p) + 12), BAR * song.sixteenth, vel, rng, voices=6, detune=9, cutoff=cutoff, attack=0.5, release=0.6), song.at(bar + i))

    def lead(notes, bar, gain=1.0, track="lead"):
        prev = None
        for nt in notes:
            p = nt.pitches[0]
            y = s.lead_voice(hz(p), nt.length * song.sixteenth * 0.95, gain * (1.1 if nt.accent else 1), rng, glide_from=hz(prev) if prev and nt.start else None, cutoff=2600, vib_cents=24)
            song.tracks[track].add(y, song.at(bar, nt.start))
            prev = p

    def section(bar, nbars, chords=LOOP, **kw):
        for i in range(nbars):
            drums(bar + i, **kw)
            sub(bar + i, chords[i % len(chords)])

    def rain_over(bar, bars):
        # Two independent showers, left and right, for a wide rain.
        for pan in (-0.7, 0.7):
            song.tracks["rain"].add(rain(bars * BAR * song.sixteenth + 1.5, rng), song.at(bar), pan=pan)

    def riser(bar, bars):
        song.tracks["fx"].add(s.riser(bars * BAR * song.sixteenth, 0.9, rng, lo=400, hi=7000), song.at(bar))

    def crash(bar):
        song.tracks["fx"].add(s.cymbal(0.7, rng, decay=2.0), song.at(bar))

    hook = parse(HOOK, BAR)
    verse = parse(VERSE, BAR)
    hook_harmony = harmony(hook, LOOP)

    # Intro: the rain, the e-piano behind a closed filter (a radio in the next room), a riser.
    rain_over(0, 4)
    song.track("epiano_intro", gain=0.9, pan=0.1, sends={"hall": 0.4}, post=lambda x: s.sos_filter(x, "lowpass", 900))
    for i, c in enumerate(LOOP):
        for p in CHORDS[c]:
            song.tracks["epiano_intro"].add(s.epiano(hz(midi(p)), BAR * song.sixteenth * 0.9, 0.6, rng, decay=2.5), song.at(i))
    lead(parse("r.16 | r.16 | r.8 G5.3 F#5.3 E5.2 | C#5.8 A#4.8 |", BAR), 0, 0.6)
    riser(2, 2)
    timbal_fill(3)
    bar = 4
    # Hook.
    crash(bar)
    section(bar, 8)
    keys(bar, LOOP * 2)
    strings(bar, LOOP * 2, 0.6)
    lead(hook, bar)
    timbal_fill(bar + 7, 14)
    bar += 8
    # Verse: lighter, no strings, the e-piano and the lead talking.
    section(bar, 8, hats=False)
    for b in range(8):
        for step in range(0, 16, 4):
            song.hit("hats", s.hat(0.45, rng), bar + b, step + 2)
    keys(bar, LOOP * 2, 0.8)
    lead(verse, bar)
    riser(bar + 6, 2)
    timbal_fill(bar + 7)
    bar += 8
    # Hook with the harmony a third below.
    crash(bar)
    section(bar, 8)
    keys(bar, LOOP * 2)
    strings(bar, LOOP * 2, 0.8)
    lead(hook, bar)
    lead(hook_harmony, bar, 0.8, track="harmony")
    bar += 8
    # Bridge: the drums drop out, the rain comes back; D - A - G - F#, the strings swell.
    rain_over(bar, 4)
    keys(bar, BRIDGE_CH, 0.7)
    strings(bar, BRIDGE_CH, 1.0, cutoff=2400)
    lead(parse(BRIDGE, BAR), bar)
    for i, c in enumerate(BRIDGE_CH):
        song.tracks["sub"].add(s.sub808(hz(midi(SUB[c])), BAR * song.sixteenth * 0.9, 0.6, rng), song.at(bar + i))
    riser(bar + 2, 2)
    timbal_fill(bar + 3, 8)
    bar += 4
    # Last hook: everything, the countermelody on top.
    crash(bar)
    section(bar, 8)
    keys(bar, LOOP * 2)
    strings(bar, LOOP * 2, 0.8)
    lead(hook, bar)
    lead(hook_harmony, bar, 0.7, track="harmony")
    lead(parse(COUNTER, BAR), bar, 0.45, track="harmony")
    bar += 8
    # Outro: rain and the e-piano alone, the hook's first line once more.
    rain_over(bar, 4)
    keys(bar, LOOP, 0.6)
    lead([x for x in hook if x.start < 2 * BAR], bar, 0.7)
    for i in range(2):
        drums(bar + i, kick=False, snare=False)
    bar += 4
    assert bar == song.bars, bar
    end = song.at(bar)
    song.tracks["kick"].add(s.kick(1.0, rng, f0=50, f1=130, decay=0.4, click=0.35, drive=1.8), end)
    song.tracks["sub"].add(s.sub808(hz(midi("B1")), 1.8, 1.0, rng), end)
    song.tracks["rim"].add(s.rimshot(1.0, rng), end)
    song.tracks["fx"].add(s.cymbal(0.8, rng, decay=2.2), end)
    for p in CHORDS["Bm"]:
        song.tracks["epiano"].add(s.epiano(hz(midi(p)), 2.5, 0.8, rng, decay=2.5), end)
    return song, buses
