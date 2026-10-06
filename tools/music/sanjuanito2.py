"""San Juanito: "Neblina en el Pichincha" (original). 2/4 at 112 bpm, A minor <-> C major.

The melancholic one (a "sanjuanito triste"), against the brisk festive first song: slower, lower,
led by a violin with the rondador answering and harmonizing, an Andean harp (arpa) playing the
bass and chords instead of the charango rasgueo, and a soft guitar. The melody leans on the
short-long-short cell (16th - 8th - 16th) and dotted, sighing figures.

Form: intro (rondador alone over the bombo, then the harp) - estribillo (violin) - A (violin) -
estribillo (rondador in thirds) - B (C major, rondador and violin) - harp interlude - A' (violin
with the rondador a third below) - estribillo / coda - "tan, tan, taaan".
"""

from __future__ import annotations

import synth as s
from score import Bus, Note, Song, parse, reverb_bus
from synth import hz, midi

BAR = 8  # 2/4 in sixteenths

# Harp: low bass string and three chord tones above (the right hand).
HARP = {
    "Am": ("A2", "E3", ["A3", "C4", "E4"]),
    "C": ("C3", "G2", ["G3", "C4", "E4"]),
    "G": ("G2", "D3", ["G3", "B3", "D4"]),
    "Em": ("E2", "B2", ["G3", "B3", "E4"]),
    "Dm": ("D3", "A2", ["A3", "D4", "F4"]),
}
GUITAR = {
    "Am": ["A2", "E3", "A3", "C4", "E4"],
    "C": ["C3", "G3", "C4", "E4", "G4"],
    "G": ["G2", "D3", "G3", "B3", "D4"],
    "Em": ["E2", "B2", "E3", "G3", "B3"],
    "Dm": ["D3", "A3", "D4", "F4"],
}

# ---- the tunes (all original) ----------------------------------------------------------------

ESTRIBILLO = """
E5.1> A5.2 G5.1 E5.2 D5.2 | C5.1 D5.1 E5.2 A4.4 | G4.1> A4.2 C5.1 D5.2 E5.2 | G5.3 E5.1 D5.4 |
E5.1> A5.2 G5.1 E5.2 D5.2 | C5.1 D5.1 E5.2 G5.4 | A5.1 G5.2 E5.1 D5.2 C5.2 | D5.1 C5.1 A4.6 |
"""
ESTRIBILLO_CH = ["Am", "Am", "C", "G", "Am", "C", "Em", "Am"]

VERSE_A = """
A4.3 C5.1 E5.2 D5.2 | C5.1 A4.1 G4.2 A4.4 | C5.3 D5.1 E5.2 G5.2 | E5.1 D5.1 C5.2 D5.4 |
E5.3 G5.1 A5.2 G5.2 | E5.1 D5.1 E5.2 G5.4 | A5.1 G5.2 E5.1 D5.2 C5.2 | D5.8 |
A4.3 C5.1 E5.2 D5.2 | C5.1 A4.1 G4.2 A4.4 | C5.3 D5.1 E5.2 G5.2 | A5.1 G5.1 E5.2 G5.4 |
E5.1 D5.2 C5.1 D5.2 E5.2 | G5.3 E5.1 D5.2 C5.2 | D5.1 C5.1 A4.2 G4.2 C5.2 | A4.8 |
"""
VERSE_A_CH = ["Am", "Am", "C", "G", "Am", "C", "G", "G", "Am", "Am", "C", "Em", "G", "C", "Em", "Am"]

VERSE_B = """
G5.1> A5.2 G5.1 E5.2 G5.2 | A5.1 C6.1 D6.2 C6.4 | D6.1 C6.2 A5.1 G5.2 A5.2 | G5.3 E5.1 D5.4 |
E5.1> G5.2 A5.1 C6.2 A5.2 | G5.1 E5.1 D5.2 E5.4 | G5.1 A5.2 G5.1 E5.2 D5.2 | C5.8 |
G5.1> A5.2 G5.1 E5.2 G5.2 | A5.1 C6.1 D6.2 E6.4 | D6.1 C6.2 A5.1 G5.2 E5.2 | G5.3 A5.1 G5.4 |
E5.1 D5.2 C5.1 D5.2 E5.2 | G5.3 E5.1 D5.2 C5.2 | D5.1 C5.1 A4.2 C5.2 B4.2 | A4.8 |
"""
VERSE_B_CH = ["C", "C", "G", "G", "Am", "Em", "G", "C", "C", "C", "Am", "G", "Am", "C", "Em", "Am"]

# The rondador's free-sounding opening call.
INTRO_CALL = "E5.8 | D5.4 C5.4 | A4.8 | r.8 |"

# A natural minor / C major, for the parallel thirds.
SCALE = [9, 11, 0, 2, 4, 5, 7]


def third_below(m: int) -> int:
    pc = m % 12
    if pc not in SCALE:
        return m - 3
    i = SCALE.index(pc)
    return m - (pc - SCALE[(i - 2) % 7]) % 12


def harmony(notes: list[Note]) -> list[Note]:
    return [Note(n.start, n.length, [third_below(p) for p in n.pitches], n.accent) for n in notes]


def note(step, ln, p) -> Note:
    return Note(step, ln, [midi(p)])


# ---- arrangement ------------------------------------------------------------------------------


def build() -> tuple[Song, dict]:
    song = Song("Neblina en el Pichincha", bpm=112, bar_len=BAR, bars=90, seed=1822, tail=4.0)
    rng = song.rng
    # A bigger, darker room than the first song: a church-hall echo for the violin and pipes.
    hall = s.reverb_ir(2.4, rng, predelay=0.025, damp=5000)
    buses = {"hall": Bus(reverb_bus(hall, 250), 0.55)}

    song.track("violin", gain=1.4, pan=-0.1, sends={"hall": 0.4})
    song.track("rondador", gain=0.5, pan=0.22, sends={"hall": 0.5})
    song.track("harp", gain=1.0, pan=0.3, sends={"hall": 0.3})
    song.track("harp_bass", gain=0.65, pan=0.05, sends={"hall": 0.12})
    song.track("guitar", gain=0.75, pan=-0.38, sends={"hall": 0.2})
    song.track("bombo", gain=0.42, sends={"hall": 0.15})
    song.track("chajchas", gain=1.6, pan=0.5, sends={"hall": 0.25})

    def harp_bar(bar, chord, vel=1.0):
        # Left hand: the bass string on each beat (root, then fifth); right hand: the chord tones
        # on the sanjuan cell (16th - 8th - 16th | 8th - 8th).
        root, fifth, tones = HARP[chord]
        for step, p in ((0, root), (4, fifth)):
            song.tracks["harp_bass"].add(s.pluck(hz(midi(p)), 0.5, vel, rng, bright=0.35, decay=1.4, pos=0.3, damp=0.15), song.at(bar, step) + rng.normal(0, 0.003))
        for step, k, v in ((1, 0, 0.7), (3, 1, 0.85), (4, 2, 0.6), (6, 1, 0.8), (7, 0, 0.55)):
            y = s.pluck(hz(midi(tones[k]) + 12), 0.25, vel * v, rng, bright=0.6, decay=1.1, pos=0.22, damp=0.12)
            song.tracks["harp"].add(y, song.at(bar, step) + rng.normal(0, 0.004))

    def guitar_bar(bar, chord, vel=1.0):
        # Soft strums on the cell, brushed rather than the first song's hard rasgueo.
        for step, ln, up, v in ((0, 1, False, 0.9), (1, 2, True, 0.55), (3, 1, True, 0.6), (4, 2, False, 0.8), (6, 2, True, 0.55)):
            y = s.strum(GUITAR[chord], ln * song.sixteenth * 0.95, vel * v, rng, spread=0.014, up=up, bright=0.3, decay=1.0, damp=0.06)
            song.hit("guitar", y, bar, step, jitter=0.004)

    def drums_bar(bar, vel=1.0, shakers=True):
        # Bombo over two bars: quarter, quarter | eighth, eighth, quarter.
        if bar % 2 == 0:
            song.hit("bombo", s.bombo(vel, rng, open_=True), bar, 0, jitter=0.003)
            song.hit("bombo", s.bombo(vel * 0.75, rng, open_=True), bar, 4, jitter=0.003)
        else:
            song.hit("bombo", s.bombo(vel * 0.8, rng, open_=False), bar, 0, jitter=0.003)
            song.hit("bombo", s.bombo(vel * 0.7, rng, open_=False), bar, 2, jitter=0.003)
            song.hit("bombo", s.bombo(vel * 0.95, rng, open_=True), bar, 4, jitter=0.003)
        if shakers:
            for step in range(0, 8, 2):
                song.hit("chajchas", s.shaker(vel * (0.9 if step % 4 == 0 else 0.6), rng, length=0.09, center=3800), bar, step, jitter=0.005)

    def band(bar0, chords, vel=1.0, guitar=True):
        for i, c in enumerate(chords):
            harp_bar(bar0 + i, c, vel)
            if guitar:
                guitar_bar(bar0 + i, c, vel)
            drums_bar(bar0 + i, vel)

    def violin(notes, bar, gain=1.0, octave=0):
        prev = None
        for n in notes:
            p = n.pitches[0] + octave
            # Slides into a note only from a close neighbour (a finger slide, not a siren).
            glide = hz(prev) if prev is not None and 0 < abs(p - prev) <= 4 else None
            dur = n.length * song.sixteenth * 0.97
            v = gain * (1.15 if n.accent else 1.0) * (1 + rng.normal(0, 0.06))
            song.tracks["violin"].add(s.violin(hz(p), dur, v, rng, glide_from=glide), song.at(bar, n.start) + rng.normal(0, 0.004))
            prev = p

    def rondador(notes, bar, gain=1.0, thirds=True):
        song.play("rondador", s.panpipe, notes, bar, gain=gain, legato=0.88, jitter=0.004, vel_var=0.07)
        if thirds:
            song.play("rondador", s.panpipe, harmony(notes), bar, gain=gain * 0.7, legato=0.88, jitter=0.004, vel_var=0.07)

    est = parse(ESTRIBILLO, BAR)
    va = parse(VERSE_A, BAR)
    vb = parse(VERSE_B, BAR)

    # Intro: the rondador calls over a slow bombo, then the harp comes in.
    for i in range(4):
        if i % 2 == 0:
            song.hit("bombo", s.bombo(0.8, rng, open_=True), i, 0)
        song.hit("bombo", s.bombo(0.55, rng, open_=False), i, 4)
    rondador(parse(INTRO_CALL, BAR), 0, 0.9)
    for i, c in enumerate(["Am", "C", "G", "Am"]):
        harp_bar(4 + i, c, 0.85)
        drums_bar(4 + i, 0.8, shakers=i >= 2)
    bar = 8
    # Estribillo: the violin, the rondador doubling softly.
    band(bar, ESTRIBILLO_CH)
    violin(est, bar)
    rondador(est, bar, 0.35, thirds=False)
    bar += 8
    # A: the violin alone, the rondador answering in its long notes.
    band(bar, VERSE_A_CH)
    violin(va, bar)
    rondador(parse("r.8 | r.8 | r.8 | r.8 | r.8 | r.8 | r.8 | r.2 E5.1 G5.1 A5.2 G5.2 |", BAR), bar, 0.7)
    rondador(parse("r.8 | r.8 | r.8 | r.8 | r.8 | r.8 | r.8 | r.2 C5.1 D5.1 E5.4 |", BAR), bar + 8, 0.7, thirds=False)
    bar += 16
    # Estribillo: the rondador takes it, in thirds; the violin holds long notes under it.
    band(bar, ESTRIBILLO_CH)
    rondador(est, bar)
    violin(parse("A4.8 | E5.8 | E5.8 | D5.8 | C5.8 | E5.8 | B4.8 | A4.8 |", BAR), bar, 0.6)
    bar += 8
    # B: brightening into C major, rondador and violin together (the violin an octave down).
    band(bar, VERSE_B_CH)
    rondador(vb, bar, 0.9)
    violin(vb, bar, 0.75, octave=-12)
    bar += 16
    # Interlude: the harp alone with the estribillo in its high strings, bombo and chajchas.
    song.track("harp_solo", gain=1.5, pan=0.15, sends={"hall": 0.4})
    for i, c in enumerate(ESTRIBILLO_CH):
        root, fifth, _ = HARP[c]
        for step, p in ((0, root), (4, fifth)):
            song.tracks["harp_bass"].add(s.pluck(hz(midi(p)), 0.5, 0.9, rng, bright=0.35, decay=1.4, pos=0.3, damp=0.15), song.at(bar + i, step))
        drums_bar(bar + i, 0.7)
    song.play("harp_solo", s.pluck, est, bar, jitter=0.004, vel_var=0.1, bright=0.65, decay=1.2, pos=0.18, damp=0.2)
    song.play("harp_solo", s.pluck, harmony(est), bar, gain=0.55, jitter=0.004, vel_var=0.1, bright=0.65, decay=1.2, pos=0.18, damp=0.2)
    bar += 8
    # A': the violin, the rondador a third below it.
    band(bar, VERSE_A_CH)
    violin(va, bar)
    rondador(harmony(va), bar, 0.45, thirds=False)
    bar += 16
    # Coda: the estribillo with everyone, then "tan, tan, taaan".
    band(bar, ESTRIBILLO_CH)
    violin(est, bar)
    rondador(est, bar, 0.6)
    bar += 8
    for step in (0, 4):
        song.hit("guitar", s.strum(GUITAR["Am"], 0.2, 1.0, rng, spread=0.008, bright=0.35, decay=1.0, damp=0.05), bar, step)
        song.hit("bombo", s.bombo(1.0, rng, open_=False), bar, step)
        song.tracks["harp_bass"].add(s.pluck(hz(midi("A2")), 0.3, 1.0, rng, bright=0.35, decay=1.2, pos=0.3, damp=0.1), song.at(bar, step))
    end = song.at(bar + 1)
    song.tracks["guitar"].add(s.strum(GUITAR["Am"], 3.0, 1.0, rng, spread=0.03, bright=0.35, decay=1.8, damp=0.6), end)
    song.tracks["harp"].add(s.strum([midi(p) + 12 for p in HARP["Am"][2]] + [midi("A5")], 3.0, 1.0, rng, spread=0.05, bright=0.6, decay=2.0, damp=0.8), end)
    song.tracks["harp_bass"].add(s.pluck(hz(midi("A1")), 3.0, 1.1, rng, bright=0.35, decay=2.0, pos=0.3, damp=0.8), end)
    song.hit("bombo", s.bombo(1.1, rng, open_=True), bar + 1, 0)
    violin([note(0, 16, "A4")], bar)
    rondador([note(0, 16, "E5")], bar, 0.6, thirds=False)
    bar += 2
    assert bar == song.bars, bar
    return song, buses
