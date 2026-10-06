"""San Juanito: "Guambrita del Panecillo" (original). 2/4 at 124 bpm, E minor <-> G major.

Form: intro (charango, then the band) - estribillo - A (quena) - estribillo - B (rondador, in G
then back to E minor) - interlude (charango solo, breakdown) - estribillo - A' (quena + rondador)
- B' - estribillo/coda - "tan, tan, taaan" ending.
"""

from __future__ import annotations

import numpy as np

import synth as s
from score import Bus, Song, parse, reverb_bus

BAR = 8  # 2/4 in sixteenths

# Rhythm guitar/charango voicings.
GUITAR = {
    "Em": ["E2", "B2", "E3", "G3", "B3", "E4"],
    "G": ["G2", "B2", "D3", "G3", "B3", "G4"],
    "D": ["D3", "A3", "D4", "F#4"],
    "C": ["C3", "E3", "G3", "C4", "E4"],
}
CHARANGO = {"Em": ["G4", "B4", "E5", "B4"], "G": ["G4", "B4", "D5", "G5"], "D": ["F#4", "A4", "D5", "A4"], "C": ["G4", "C5", "E5", "C5"]}
BASS = {"Em": ("E2", "B1"), "G": ("G2", "D2"), "D": ("D2", "A1"), "C": ("C2", "G1")}

# ---- the tunes (all original) ----------------------------------------------------------------

ESTRIBILLO = """
B5.1> B5.1 D6.2 B5.2 A5.2 | G5.1 A5.1 B5.2 E5.4 | G5.1 G5.1 A5.2 G5.2 E5.2 | D5.1 E5.1 G5.2 E5.4 |
B5.1> B5.1 D6.2 B5.2 A5.2 | G5.1 A5.1 B5.2 E5.4 | G5.1 A5.1 B5.2 D6.2 B5.2 | A5.1 G5.1 E5.2 E5.4 |
"""
ESTRIBILLO_CH = ["Em", "Em", "G", "Em", "Em", "Em", "G", "Em"]

VERSE_A = """
E5.1> G5.1 A5.2 A5.2 B5.2 | A5.1 G5.1 E5.2 G5.4 | D5.1 D5.1 E5.2 G5.2 A5.2 | G5.1 E5.1 D5.2 E5.4 |
E5.1> G5.1 A5.2 B5.2 D6.2 | B5.1 A5.1 B5.2 G5.4 | A5.1 G5.1 E5.2 D5.2 E5.2 | G5.1 A5.1 E5.2 E5.4 |
D6.1> D6.1 E6.2 D6.2 B5.2 | D6.1 B5.1 A5.2 G5.4 | A5.1 A5.1 B5.2 A5.2 G5.2 | E5.1 G5.1 A5.2 B5.4 |
E5.1> G5.1 A5.2 B5.2 D6.2 | B5.1 A5.1 G5.2 A5.4 | G5.1 E5.1 D5.2 E5.2 G5.2 | B4.1 D5.1 E5.6 |
"""
VERSE_A_CH = ["Em", "G", "D", "Em", "Em", "G", "D", "Em", "G", "G", "D", "Em", "Em", "D", "G", "Em"]

VERSE_B = """
G5.1> A5.1 B5.2 B5.2 D6.2 | E6.1 D6.1 B5.2 D6.4 | A5.1 B5.1 D6.2 B5.2 A5.2 | G5.1 A5.1 B5.2 G5.4 |
G5.1> A5.1 B5.2 D6.2 E6.2 | D6.1 B5.1 A5.2 G5.4 | A5.1 B5.1 A5.2 G5.2 E5.2 | D5.1 E5.1 G5.2 G5.4 |
E6.1> E6.1 D6.2 B5.2 D6.2 | B5.1 A5.1 G5.2 A5.4 | B5.1 B5.1 A5.2 G5.2 E5.2 | G5.1 A5.1 B5.2 B5.4 |
E6.1> D6.1 B5.2 A5.2 G5.2 | A5.1 G5.1 E5.2 D5.4 | E5.1 G5.1 A5.2 G5.2 E5.2 | D5.1 E5.1 E5.6 |
"""
VERSE_B_CH = ["G", "G", "D", "G", "C", "G", "D", "G", "Em", "D", "Em", "Em", "G", "D", "Em", "Em"]

CHARANGO_SOLO = """
E5.1 G5.1 B5.1 G5.1 E5.1 G5.1 B5.1 E6.1 | D6.1 B5.1 G5.1 B5.1 D6.1 B5.1 G5.1 D5.1 |
F#5.1 A5.1 D6.1 A5.1 F#5.1 A5.1 D6.1 A5.1 | G5.1 E5.1 B4.1 E5.1 G5.2 E5.2 |
B5.1 B5.1 A5.1 G5.1 A5.1 A5.1 G5.1 E5.1 | G5.1 G5.1 E5.1 D5.1 E5.1 G5.1 A5.1 B5.1 |
A5.1 G5.1 E5.1 D5.1 E5.2 D5.2 | E5.1 E5.1 G5.2 E5.4 |
"""
SOLO_CH = ["Em", "G", "D", "Em", "Em", "G", "D", "Em"]

# E natural minor / G major, for the rondador's parallel thirds.
SCALE = [4, 6, 7, 9, 11, 0, 2]


def third_below(m: int) -> int:
    pc = m % 12
    if pc not in SCALE:
        return m - 3
    i = SCALE.index(pc)
    below = SCALE[(i - 2) % 7]
    d = (pc - below) % 12
    return m - d


def harmony(notes):
    out = []
    for n in notes:
        h = type(n)(n.start, n.length, [third_below(p) for p in n.pitches], n.accent)
        out.append(h)
    return out


# ---- arrangement ------------------------------------------------------------------------------


def build() -> tuple[Song, dict]:
    song = Song("Guambrita del Panecillo", bpm=124, bar_len=BAR, bars=114, seed=1534, tail=3.5)
    rng = song.rng
    ir_room = s.reverb_ir(1.6, rng, predelay=0.015, damp=7000)
    buses = {"room": Bus(reverb_bus(ir_room), 0.5)}

    song.track("quena", gain=0.55, pan=-0.12, sends={"room": 0.35})
    song.track("rondador", gain=0.5, pan=0.18, sends={"room": 0.45})
    song.track("charango", gain=0.42, pan=0.35, sends={"room": 0.2})
    song.track("guitar", gain=0.55, pan=-0.35, sends={"room": 0.18})
    song.track("bass", gain=0.62, pan=0.0)
    song.track("bombo", gain=0.85, pan=0.0, sends={"room": 0.12})
    song.track("rim", gain=0.25, pan=0.1, sends={"room": 0.15})
    song.track("chajchas", gain=0.3, pan=0.45, sends={"room": 0.2})

    live = dict(jitter=0.004, vel_var=0.07)

    def strum_bar(bar, chord, vel=1.0, guitar=True, charango=True):
        # Guitar: the sanjuan cell (16th - 8th - 16th | 8th - 8th), down/up strokes.
        if guitar:
            for step, ln, up, v in ((0, 1, False, 1.0), (1, 2, True, 0.7), (3, 1, True, 0.75), (4, 2, False, 0.95), (6, 2, True, 0.7)):
                y = s.strum(GUITAR[chord], ln * song.sixteenth * 0.95, vel * v, rng, spread=0.009, up=up, bright=0.45, decay=1.0, damp=0.05)
                song.hit("guitar", y, bar, step, jitter=0.003)
        if charango:
            # Charango: a bright rasgueo on every sixteenth, accented on the cell.
            acc = (1.0, 0.8, 0.45, 0.85, 0.95, 0.45, 0.8, 0.5)
            for step in range(8):
                y = s.strum(CHARANGO[chord], song.sixteenth * 0.9, vel * acc[step], rng, spread=0.005, up=step % 2 == 1, bright=0.85, decay=0.5, pos=0.12, damp=0.03)
                song.hit("charango", y, bar, step, jitter=0.003)

    def bass_bar(bar, chord, vel=1.0):
        root, fifth = BASS[chord]
        for step, ln, p in ((0, 3, root), (3, 1, root), (4, 4, fifth)):
            song.play("bass", s.bass, [type_note(step, ln, p)], bar, gain=vel, jitter=0.003, decay=0.5, tone=0.4, legato=0.9)

    def drums_bar(bar, vel=1.0, rim=True):
        # Bombo over two bars: quarter, quarter | eighth, eighth, quarter.
        if bar % 2 == 0:
            song.hit("bombo", s.bombo(vel, rng, open_=True), bar, 0, jitter=0.003)
            song.hit("bombo", s.bombo(vel * 0.8, rng, open_=True), bar, 4, jitter=0.003)
        else:
            song.hit("bombo", s.bombo(vel * 0.85, rng, open_=False), bar, 0, jitter=0.003)
            song.hit("bombo", s.bombo(vel * 0.75, rng, open_=False), bar, 2, jitter=0.003)
            song.hit("bombo", s.bombo(vel, rng, open_=True), bar, 4, jitter=0.003)
        if rim:
            for step in (2, 6) if bar % 2 == 0 else (6,):
                song.hit("rim", s.wood(vel, rng, freq=900), bar, step, jitter=0.003)
        acc = (1, 0.45, 0.7, 0.5, 0.9, 0.45, 0.7, 0.55)
        for step in range(8):
            song.hit("chajchas", s.shaker(vel * acc[step], rng, length=0.06, center=4200), bar, step, jitter=0.004)

    def band(bar0, chords, vel=1.0, **kw):
        for i, c in enumerate(chords):
            strum_bar(bar0 + i, c, vel, **kw)
            bass_bar(bar0 + i, c, vel)
            drums_bar(bar0 + i, vel)

    est = parse(ESTRIBILLO, BAR)
    va = parse(VERSE_A, BAR)
    vb = parse(VERSE_B, BAR)
    solo = parse(CHARANGO_SOLO, BAR)

    def quena(notes, bar, gain=1.0):
        song.play("quena", s.flute, notes, bar, gain=gain, legato=0.92, **live)

    def rondador(notes, bar, gain=1.0, thirds=True):
        song.play("rondador", s.panpipe, notes, bar, gain=gain, legato=0.85, **live)
        if thirds:
            song.play("rondador", s.panpipe, harmony(notes), bar, gain=gain * 0.7, legato=0.85, **live)

    bar = 0
    # Intro: charango alone, then the band.
    strum_bar(0, "Em", 0.8, guitar=False)
    strum_bar(1, "Em", 0.9, guitar=False)
    band(2, ["Em", "G", "D", "Em"])
    bar = 6
    # Estribillo 1.
    band(bar, ESTRIBILLO_CH)
    quena(est, bar)
    rondador(est, bar, 0.6, thirds=False)
    bar += 8
    # A: the quena sings.
    band(bar, VERSE_A_CH)
    quena(va, bar)
    bar += 16
    # Estribillo 2.
    band(bar, ESTRIBILLO_CH)
    quena(est, bar)
    rondador(est, bar, 0.6, thirds=False)
    bar += 8
    # B: rondador in thirds, to the relative major and back.
    band(bar, VERSE_B_CH)
    rondador(vb, bar)
    bar += 16
    # Interlude: charango solo over guitar, bass and bombo.
    for i, c in enumerate(SOLO_CH):
        strum_bar(bar + i, c, 0.8, charango=False)
        bass_bar(bar + i, c)
        drums_bar(bar + i, 0.9)
    song.track("charango_solo", gain=0.5, pan=0.2, sends={"room": 0.3})
    song.play("charango_solo", s.pluck, solo, bar, jitter=0.003, vel_var=0.1, bright=0.85, decay=0.45, pos=0.12, damp=0.04)
    song.play("charango_solo", s.pluck, solo, bar, gain=0.6, jitter=0.004, vel_var=0.1, bright=0.85, decay=0.45, pos=0.2, damp=0.04)
    bar += 8
    # Breakdown: bombo, chajchas and long rondador notes.
    for i, c in enumerate(["Em", "G", "D", "Em"]):
        drums_bar(bar + i, 0.8, rim=False)
        bass_bar(bar + i, c, 0.6)
    rondador(parse("B5.8 | D6.8 | A5.8 | B5.4 G5.4 |", BAR), bar, 0.8)
    bar += 4
    # Estribillo 3.
    band(bar, ESTRIBILLO_CH)
    quena(est, bar)
    rondador(est, bar, 0.7, thirds=True)
    bar += 8
    # A': quena with the rondador in thirds under it.
    band(bar, VERSE_A_CH)
    quena(va, bar)
    rondador(harmony(va), bar, 0.45, thirds=False)
    bar += 16
    # B': both.
    band(bar, VERSE_B_CH)
    rondador(vb, bar)
    quena(vb, bar, 0.6)
    bar += 16
    # Coda: the estribillo once more, then "tan, tan, taaan".
    band(bar, ESTRIBILLO_CH[:6])
    quena(est[: len([n for n in est if n.start < 6 * BAR])], bar)
    rondador([n for n in est if n.start < 6 * BAR], bar, 0.6, thirds=True)
    bar += 6
    for step, v in ((0, 1.0), (4, 1.0)):
        y = s.strum(GUITAR["Em"], 0.2, v, rng, spread=0.006, bright=0.5, decay=1.0, damp=0.05)
        song.hit("guitar", y, bar, step)
        song.hit("charango", s.strum(CHARANGO["Em"], 0.2, v, rng, spread=0.004, bright=0.85, decay=0.5, damp=0.03), bar, step)
        song.hit("bombo", s.bombo(1.0, rng, open_=False), bar, step)
        song.play("bass", s.bass, [type_note(step, 2, "E2")], bar, decay=0.4)
    song.hit("guitar", s.strum(GUITAR["Em"], 2.4, 1.1, rng, spread=0.02, bright=0.5, decay=1.6, damp=0.4), bar + 1, 0)
    song.hit("charango", s.strum(CHARANGO["Em"], 2.4, 1.0, rng, spread=0.012, bright=0.85, decay=0.9, damp=0.4), bar + 1, 0)
    song.hit("bombo", s.bombo(1.15, rng, open_=True), bar + 1, 0)
    song.play("bass", s.bass, [type_note(0, 8, "E2")], bar + 1, decay=1.2)
    song.play("quena", s.flute, [type_note(0, 16, "E5")], bar, legato=1.0)
    song.play("rondador", s.panpipe, [type_note(0, 16, "B4")], bar, gain=0.6, legato=1.0)
    bar += 2
    assert bar == song.bars, bar
    return song, buses


def type_note(step, ln, p):
    from score import Note
    from synth import midi

    return Note(step, ln, [midi(p)])
