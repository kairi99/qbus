"""Reggaeton: "Perreo en la Ecovía" (original). 4/4 at 94 bpm, F minor, Fm-Db-Ab-Eb loop.

Form: intro (filtered pad + hook, riser) - hook - verse (sung-like synth lead, nylon guitar) -
pre-hook (no kick, snare roll) - hook (+ countermelody) - bridge (no kick) - hook - outro, final hit.
Drums: kick on every beat, snare/rim on the dembow sixteenths (3+3+2: steps 4, 7, 12, 15 of 16).
"""

from __future__ import annotations

import numpy as np

import synth as s
from score import Bus, Note, Song, parse, reverb_bus, sidechain
from synth import SR, hz, midi

BAR = 16
LOOP = ["Fm", "Db", "Ab", "Eb"]
PAD = {"Fm": ["F3", "Ab3", "C4", "F4"], "Db": ["F3", "Ab3", "Db4", "F4"], "Ab": ["Eb3", "Ab3", "C4", "Eb4"], "Eb": ["Eb3", "G3", "Bb3", "Eb4"]}
SUB = {"Fm": "F1", "Db": "Db2", "Ab": "Ab1", "Eb": "Eb2"}
ARP = {"Fm": ["F3", "C4", "F4", "Ab4"], "Db": ["Db3", "Ab3", "Db4", "F4"], "Ab": ["Ab2", "Eb3", "Ab3", "C4"], "Eb": ["Eb3", "Bb3", "Eb4", "G4"]}

HOOK = """
C5.3> C5.3 Ab4.2 F4.2 Ab4.2 C5.2 Eb5.2 | Db5.3> C5.3 Ab4.2 F4.4 r.4 |
Eb5.3> Eb5.3 C5.2 Ab4.2 C5.2 Eb5.2 F5.2 | Eb5.3> Db5.3 C5.2 Bb4.6 r.2 |
C5.3> C5.3 Ab4.2 F4.2 Ab4.2 C5.2 F5.2 | F5.3> Eb5.3 Db5.2 C5.4 Ab4.4 |
C5.3> Eb5.3 C5.2 Ab4.2 Bb4.2 C5.2 Eb5.2 | Db5.3> C5.3 Bb4.2 G4.6 r.2 |
"""
VERSE = """
r.2 F4.2 Ab4.2 Ab4.2 Bb4.2 Ab4.2 F4.4 | r.2 F4.2 Ab4.2 Bb4.2 C5.4 Ab4.4 |
r.2 C5.2 C5.2 Bb4.2 Ab4.2 Bb4.2 C5.4 | Bb4.4 G4.4 Eb4.8 |
r.2 F4.2 Ab4.2 C5.2 Eb5.4 C5.4 | Db5.2 C5.2 Ab4.4 F4.8 |
r.2 Eb4.2 F4.2 Ab4.2 C5.2 Bb4.2 Ab4.4 | G4.4 Bb4.4 Eb5.8 |
"""
PRE = """
F4.4 Ab4.4 C5.4 Db5.4 | C5.8 Ab4.8 | Eb5.4 C5.4 Ab4.4 C5.4 | Bb4.12 r.4 |
"""
COUNTER = """
F5.8 Eb5.8 | Db5.8 C5.8 | C5.8 Eb5.8 | Bb4.16 |
F5.8 Ab5.8 | F5.8 Db5.8 | Eb5.8 C5.8 | Bb4.8 G4.8 |
"""
BRIDGE = """
C5.6 Ab4.2 F4.4 Ab4.4 | Bb4.6 Ab4.2 F4.8 | Eb5.6 C5.2 Ab4.4 C5.4 | Bb4.12 r.4 |
C5.6 Ab4.2 F4.4 C5.4 | Db5.6 C5.2 Ab4.8 | Eb5.6 F5.2 Eb5.4 C5.4 | Bb4.4 G4.4 Bb4.8 |
"""


def build() -> tuple[Song, dict]:
    song = Song("Perreo en la Ecovía", bpm=94, bar_len=BAR, bars=52, seed=2004, tail=3.0)
    rng = song.rng
    hall = s.reverb_ir(2.2, rng, predelay=0.02, damp=7000)
    plate = s.reverb_ir(1.0, rng, predelay=0.005, damp=9000)
    dotted8 = 0.75 * 60 / song.bpm
    buses = {
        "hall": Bus(reverb_bus(hall, 250), 0.4),
        "plate": Bus(reverb_bus(plate, 400), 0.35),
        "delay": Bus(lambda x: s.delay(x, dotted8, feedback=0.4, repeats=5, lowpass=4000), 0.4),
    }
    kicks: list[float] = []
    n = int(song.length * SR)
    pump = lambda depth: (lambda x: x * sidechain(kicks, n, depth=depth, release=0.16)[: x.shape[1]])

    song.track("kick", gain=0.55)
    song.track("sub", gain=0.36)
    song.track("snare", gain=1.2, sends={"plate": 0.25})
    song.track("clap", gain=1.0, pan=0.05, sends={"plate": 0.35})
    song.track("hats", gain=0.7, pan=0.25)
    song.track("perc", gain=1.2, pan=-0.3, sends={"plate": 0.2})
    song.track("pad", gain=0.38, sends={"hall": 0.45}, post=pump(0.45))
    song.track("pluck", gain=1.3, pan=0.1, sends={"delay": 0.35, "plate": 0.2}, post=pump(0.25))
    song.track("guitar", gain=0.75, pan=-0.3, sends={"hall": 0.25}, post=pump(0.2))
    song.track("lead", gain=1.1, pan=-0.05, sends={"hall": 0.3, "delay": 0.2})
    song.track("fx", gain=0.7, sends={"hall": 0.3})

    def drums(bar, kick=True, snare=True, hats=True, clap=False, roll=False):
        if kick:
            for step in (0, 4, 8, 12):
                song.hit("kick", s.kick(1.0, rng, f0=48, f1=150, decay=0.28, click=0.5, drive=2.2), bar, step)
                kicks.append(song.at(bar, step))
        if snare:
            steps = [3, 6, 11, 14] + ([9] if bar % 4 == 3 else [])
            for step in steps:
                song.hit("snare", s.rimshot(1.0 if step in (3, 11) else 0.9, rng), bar, step)
                if clap and step in (6, 14):
                    song.hit("clap", s.clap(0.9, rng), bar, step)
        if hats:
            for step in range(0, 16, 2):
                song.hit("hats", s.hat(0.9 if step % 4 == 2 else 0.6, rng), bar, step)
            if bar % 2 == 1:
                # A sixteenth roll into the next bar.
                for step in (13, 15):
                    song.hit("hats", s.hat(0.5, rng), bar, step)
        if roll:
            for i in range(16):
                song.hit("snare", s.rimshot(0.3 + 0.045 * i, rng), bar, i)

    def sub(bar, chord, vel=1.0):
        p = midi(SUB[chord])
        prev = None
        for step, ln, d in ((0, 3, 0), (3, 3, 0), (6, 2, 12), (8, 3, 0), (11, 3, 0), (14, 2, 12)):
            y = s.sub808(hz(p + d), ln * song.sixteenth * 0.92, vel, rng, glide_from=hz(prev) if prev and prev != p + d else None)
            song.tracks["sub"].add(y, song.at(bar, step))
            prev = p + d

    def pad(bar, chords, vel=1.0, cutoff=2400):
        for i, c in enumerate(chords):
            for p in PAD[c]:
                song.tracks["pad"].add(s.pad(hz(midi(p)), BAR * song.sixteenth, vel, rng, cutoff=cutoff, attack=0.08, release=0.4), song.at(bar + i))

    def guitar(bar, chords):
        # Nylon-string arpeggio on the tresillo.
        for i, c in enumerate(chords):
            notes = ARP[c]
            for k, step in enumerate((0, 3, 6, 8, 10, 12, 14)):
                p = midi(notes[[0, 1, 2, 3, 2, 1, 2][k]])
                song.tracks["guitar"].add(s.pluck(hz(p), song.sixteenth * 2.5, 0.8, rng, bright=0.4, decay=1.0, pos=0.2, damp=0.1), song.at(bar + i, step))

    def section(bar, nbars, **kw):
        for i in range(nbars):
            c = LOOP[i % 4]
            drums(bar + i, **kw)
            sub(bar + i, c)

    hook = parse(HOOK, BAR)
    verse = parse(VERSE, BAR)

    def pluck(notes, bar, gain=1.0, cutoff=(5000, 500)):
        song.play("pluck", s.synth_pluck, notes, bar, gain=gain, cutoff=cutoff, decay=0.3)

    def lead(notes, bar, gain=1.0):
        prev = None
        for nt in notes:
            p = nt.pitches[0]
            y = s.lead_voice(hz(p), nt.length * song.sixteenth * 0.95, gain, rng, glide_from=hz(prev) if prev and nt.start else None)
            song.tracks["lead"].add(y, song.at(bar, nt.start))
            prev = p

    def riser(bar, bars):
        song.tracks["fx"].add(s.riser(bars * BAR * song.sixteenth, 1.0, rng), song.at(bar))

    def crash(bar):
        song.tracks["fx"].add(s.cymbal(0.8, rng, decay=1.8), song.at(bar))

    # Intro: dark pad and the hook through a closed filter, shaker, riser.
    pad(0, LOOP, 0.8, cutoff=900)
    pluck(hook[: sum(1 for x in hook if x.start < 4 * BAR)], 0, 0.7, cutoff=(1200, 300))
    for b in range(4):
        for step in range(0, 16, 2):
            song.hit("perc", s.shaker(0.6 if step % 4 else 0.9, rng, length=0.05, center=6000), b, step)
    riser(2, 2)
    bar = 4
    # Hook.
    crash(bar)
    section(bar, 8)
    pad(bar, LOOP * 2)
    pluck(hook, bar)
    bar += 8
    # Verse.
    section(bar, 8, hats=False)
    for b in range(8):
        for step in range(0, 16, 2):
            song.hit("hats", s.hat(0.5, rng), bar + b, step)
    guitar(bar, LOOP * 2)
    pad(bar, LOOP * 2, 0.5, cutoff=1500)
    lead(verse, bar)
    bar += 8
    # Pre-hook: no kick, the sub holds, a snare roll and riser.
    for i in range(4):
        drums(bar + i, kick=False, hats=i < 3, roll=i == 3, snare=i < 3)
        song.tracks["sub"].add(s.sub808(hz(midi(SUB[LOOP[i]])), BAR * song.sixteenth * 0.95, 0.7, rng), song.at(bar + i))
    pad(bar, LOOP, 0.9, cutoff=1800)
    lead(parse(PRE, BAR), bar)
    riser(bar + 2, 2)
    bar += 4
    # Hook with the countermelody.
    crash(bar)
    section(bar, 8, clap=True)
    pad(bar, LOOP * 2)
    pluck(hook, bar)
    lead(parse(COUNTER, BAR), bar, 0.7)
    bar += 8
    # Bridge: no kick, guitar and lead, hats only.
    for i in range(8):
        drums(bar + i, kick=False, snare=i >= 4, hats=True)
    guitar(bar, LOOP * 2)
    pad(bar, LOOP * 2, 0.8, cutoff=1400)
    lead(parse(BRIDGE, BAR), bar)
    for i in range(8):
        if i % 2 == 0:
            song.tracks["sub"].add(s.sub808(hz(midi(SUB[LOOP[i % 4]])), 2 * BAR * song.sixteenth * 0.5, 0.6, rng), song.at(bar + i))
    riser(bar + 6, 2)
    bar += 8
    # Last hook: everything.
    crash(bar)
    section(bar, 8, clap=True)
    pad(bar, LOOP * 2)
    pluck(hook, bar)
    guitar(bar, LOOP * 2)
    lead(parse(COUNTER, BAR), bar, 0.6)
    bar += 8
    # Outro: filtered pad and hook, then the final hit.
    pad(bar, LOOP, 0.8, cutoff=900)
    pluck(hook[: sum(1 for x in hook if x.start < 4 * BAR)], bar, 0.6, cutoff=(1200, 300))
    for i in range(3):
        drums(bar + i, kick=False, snare=False, hats=True)
    bar += 4
    assert bar == song.bars, bar
    end = song.at(bar)
    song.tracks["kick"].add(s.kick(1.0, rng, f0=48, f1=150, decay=0.4, click=0.5, drive=2.2), end)
    song.tracks["sub"].add(s.sub808(hz(midi("F1")), 1.6, 1.0, rng), end)
    song.tracks["snare"].add(s.rimshot(1.0, rng), end)
    song.tracks["fx"].add(s.cymbal(0.9, rng, decay=2.0), end)
    for p in PAD["Fm"]:
        song.tracks["pad"].add(s.pad(hz(midi(p)), 1.5, 1.0, rng, cutoff=1500, attack=0.01, release=1.2), end)
    return song, buses
