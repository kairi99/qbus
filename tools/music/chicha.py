"""Chicha (Peruvian/Andean cumbia): "Cumbia del Trole Perdido" (original). 4/4 at 100 bpm, A minor.

Form: intro (organ + güiro, guitar pickup) - A (lead guitar) - A (guitar + organ answers) -
B (organ lead, C major) - guitar solo (huayno-style sixteenths) - percussion break - A (guitar
and organ in unison) - coda tag and final hit.
"""

from __future__ import annotations

import numpy as np

import synth as s
from score import Bus, Note, Song, parse, reverb_bus, transpose
from synth import SR, hz, midi

BAR = 16

CHORD_TONES = {
    "Am": ["A3", "C4", "E4"],
    "G": ["G3", "B3", "D4"],
    "C": ["G3", "C4", "E4"],
    "Dm": ["A3", "D4", "F4"],
    "E7": ["G#3", "B3", "D4", "E4"],
    "F": ["A3", "C4", "F4"],
}
ROOTS = {"Am": ("A1", "E2"), "G": ("G1", "D2"), "C": ("C2", "G2"), "Dm": ("D2", "A1"), "E7": ("E2", "B1"), "F": ("F1", "C2")}

THEME = """
r.2 A4.1> C5.1 E5.2 D5.2 C5.2 A4.2 G4.2 A4.2 | C5.1 D5.1 E5.4 r.2 E5.1 G5.1 A5.4 G5.2 |
E5.2> E5.1 D5.1 C5.2 D5.2 E5.4 C5.2 D5.2 | A4.6 r.2 G4.1 A4.1 C5.2 E5.4 |
G5.2> G5.1 E5.1 D5.2 E5.2 G5.4 A5.2 G5.2 | E5.1 D5.1 C5.2 D5.4 r.2 C5.1 D5.1 E5.4 |
D5.2 C5.2 A4.2 C5.2 B4.2 G#4.2 B4.4 | A4.8 r.4 E4.1 G4.1 A4.2 |
"""
THEME_CH = ["Am", "G", "C", "Am", "G", "Dm", "E7", "Am"]

B_TUNE = """
G5.2> E5.2 G5.2 A5.2 C6.4 A5.4 | G5.2 E5.2 D5.2 E5.2 G5.8 |
A5.2> G5.2 E5.2 G5.2 A5.4 C6.2 D6.2 | C6.2 A5.2 G5.2 E5.2 G5.8 |
E5.2> G5.2 A5.2 G5.2 E5.4 D5.4 | C5.2 D5.2 E5.2 G5.2 E5.8 |
D5.2 E5.2 D5.2 C5.2 B4.4 D5.4 | C5.2 B4.2 A4.12 |
"""
B_CH = ["C", "G", "F", "C", "Am", "C", "E7", "Am"]

# Organ answers between the guitar's phrases in the second A.
ANSWERS = """
r.16 | r.8 A5.2 G5.2 E5.2 D5.2 | r.16 | r.8 E5.2 G5.2 A5.4 |
r.16 | r.8 F5.2 E5.2 D5.2 C5.2 | r.16 | r.8 C6.2 B5.2 A5.4 |
"""

PENTA = [midi(n) for n in ("A4", "C5", "D5", "E5", "G5", "A5", "C6", "D6", "E6")]
CHORD_PC = {"Am": {9, 0, 4}, "G": {7, 11, 2}, "C": {0, 4, 7}, "Dm": {2, 5, 9}, "E7": {4, 8, 11, 2}, "F": {5, 9, 0}}


def solo(chords: list[str], rng: np.random.Generator) -> list[Note]:
    """Huayno-flavoured sixteenth runs: per beat a motif on the pentatonic, anchored on chord tones,
    each two-bar phrase landing on a long chord tone."""
    motifs = [(0, 0, 1, 0), (2, 1, 0, -1), (0, 1, 2, 1), (0, -1, 0, 1), (3, 2, 1, 0), (0, 0, -1, -2), (1, 0, 1, 2)]
    notes: list[Note] = []
    idx = 4
    for b, ch in enumerate(chords):
        for beat in range(4):
            start = b * BAR + beat * 4
            if b % 2 == 1 and beat >= 2:
                if beat == 2:
                    # Land: the nearest chord tone, held, with a bend into it.
                    cands = [i for i, p in enumerate(PENTA) if p % 12 in CHORD_PC[ch]] or [idx]
                    idx = min(cands, key=lambda i: abs(i - idx))
                    notes.append(Note(start, 8, [PENTA[idx]], True))
                continue
            m = motifs[rng.integers(len(motifs))]
            for k, d in enumerate(m):
                i = int(np.clip(idx + d, 0, len(PENTA) - 1))
                notes.append(Note(start + k, 1, [PENTA[i]], k == 0))
            idx = int(np.clip(idx + m[-1] + rng.integers(-1, 2), 1, len(PENTA) - 2))
    return notes


def guitar(f, dur, vel, rng, bend=False):
    """Clean, echoing chicha lead: wide vibrato on held notes, a bend up into accents."""
    n = int((dur + 0.3) * SR)
    ft = s.vibrato_track(n, f, 6.0, 28 if dur > 0.3 else 0, delay=0.12, rng=rng, scoop_cents=-100 if bend else 0, scoop_t=0.05)
    y = s.pluck(f, dur, vel, rng, bright=0.7, decay=2.2, pos=0.1, damp=0.05, freq_track=ft, tail=0.3)
    return s.softclip(y * 1.6, 1.3) * 0.7


def build() -> tuple[Song, dict]:
    song = Song("Cumbia del Trole Perdido", bpm=100, bar_len=BAR, bars=50, seed=1966, tail=3.0)
    rng = song.rng
    room = s.reverb_ir(1.2, rng, predelay=0.01, damp=6000)
    buses = {
        "room": Bus(reverb_bus(room), 0.45),
        "spring": Bus(lambda x: s.spring(s.sos_filter(x, "highpass", 300), rng, 1.6), 0.4),
        "echo": Bus(lambda x: s.delay(x, 0.18, feedback=0.4, repeats=5, lowpass=2800), 0.45),
    }
    # Gentle chicha tremolo on the lead.
    song.track("lead", gain=0.7, pan=-0.1, sends={"spring": 0.5, "echo": 0.35})
    song.track("organ", gain=0.55, pan=0.25, sends={"room": 0.3, "echo": 0.15})
    song.track("organ_pad", gain=0.18, pan=0.3, sends={"room": 0.4})
    song.track("rhythm", gain=1.0, pan=0.4, sends={"spring": 0.3})
    song.track("bass", gain=0.34)
    song.track("kick", gain=0.35)
    song.track("guiro", gain=1.2, pan=-0.4, sends={"room": 0.15})
    song.track("congas", gain=0.5, pan=0.3, sends={"room": 0.2})
    song.track("timbales", gain=0.55, pan=-0.2, sends={"room": 0.3})

    def rhythm_bar(bar, chord, vel=1.0):
        # Clean upstroke chops on the off-beats.
        voiced = [midi(p) + 12 for p in CHORD_TONES[chord]]
        for step in (2, 6, 10, 14):
            y = s.strum(voiced, song.sixteenth * 0.8, vel * (1 if step in (6, 14) else 0.8), rng, spread=0.004, up=True, bright=0.8, decay=0.4, damp=0.02)
            song.hit("rhythm", y, bar, step, jitter=0.003)

    def bass_bar(bar, chord, vel=1.0):
        root, fifth = ROOTS[chord]
        r, f5 = midi(root), midi(fifth)
        for step, ln, p in ((0, 4, r), (6, 2, f5), (8, 4, f5), (14, 2, r + 12 if r < midi("D2") else r)):
            song.tracks["bass"].add(s.bass(hz(p), ln * song.sixteenth * 0.9, vel, rng, decay=0.6, tone=0.45), song.at(bar, step) + rng.normal(0, 0.003))

    def perc_bar(bar, vel=1.0, timb=False, kick=True):
        for beat in range(4):
            # Güiro: a long scrape on the beat, two short ones after (scraaape-chk-chk).
            song.hit("guiro", s.guiro(vel, rng, length=0.11), bar, beat * 4, jitter=0.003)
            song.hit("guiro", s.guiro(vel * 0.7, rng, length=0.04), bar, beat * 4 + 2, jitter=0.003)
            song.hit("guiro", s.guiro(vel * 0.7, rng, length=0.04), bar, beat * 4 + 3, jitter=0.003)
        # Congas (tumbao): heel/mute, slap on 2, open tones on 4 and 4-and.
        for step, f, stroke, v in ((0, 200, "mute", 0.5), (4, 220, "slap", 0.9), (8, 200, "mute", 0.5), (10, 220, "mute", 0.4), (12, 220, "open", 0.9), (14, 175, "open", 1.0)):
            song.hit("congas", s.conga(vel * v, rng, f, stroke), bar, step, jitter=0.003)
        if kick:
            for step in (0, 8):
                song.hit("kick", s.kick(vel, rng, f0=55, f1=120, decay=0.22, click=0.2, drive=1.4), bar, step)
        if timb:
            # Cáscara on the timbal shell.
            for step in (0, 3, 6, 8, 10, 12, 14):
                song.hit("timbales", s.wood(vel * 0.6, rng, freq=1500, decay=0.018), bar, step, jitter=0.003)
            song.hit("timbales", s.timbal(vel * 0.6, rng, f=520), bar, 12)

    def fill(bar, start=8):
        # Timbal fill down the two drums into the next section.
        for i, step in enumerate(range(start, 16)):
            f = 600 if i < (16 - start) / 2 else 430
            song.hit("timbales", s.timbal(0.7 + 0.04 * i, rng, f=f, decay=0.25), bar, step, jitter=0.002)

    def organ_chords(bar, chords, vel=0.8):
        for i, c in enumerate(chords):
            for p in CHORD_TONES[c]:
                song.tracks["organ_pad"].add(s.organ(hz(midi(p) + 12), BAR * song.sixteenth * 0.98, vel, rng, vib_cents=8), song.at(bar + i))

    def band(bar, chords, timb=False, pad=True):
        for i, c in enumerate(chords):
            rhythm_bar(bar + i, c)
            bass_bar(bar + i, c)
            perc_bar(bar + i, timb=timb)
        if pad:
            organ_chords(bar, chords)

    theme = parse(THEME, BAR)
    btune = parse(B_TUNE, BAR)
    answers = parse(ANSWERS, BAR)

    def lead(notes, bar, gain=1.0):
        for n in notes:
            dur = n.length * song.sixteenth * 0.95
            y = guitar(hz(n.pitches[0]), dur, gain * (1.2 if n.accent else 1) * (1 + rng.normal(0, 0.06)), rng, bend=n.accent and n.length >= 2 and rng.random() < 0.6)
            song.tracks["lead"].add(s.tremolo(y, 7.0, 0.25), song.at(bar, n.start) + rng.normal(0, 0.003))

    def organ_lead(notes, bar, gain=1.0, octave=0):
        song.play("organ", s.organ, transpose(notes, octave), bar, gain=gain, legato=0.9, jitter=0.002)

    # Intro: organ swell and güiro, then the groove with a guitar pickup.
    organ_chords(0, ["Am", "Am"], 0.6)
    for b in (0, 1):
        for beat in range(4):
            song.hit("guiro", s.guiro(0.9, rng, length=0.11), b, beat * 4)
            song.hit("guiro", s.guiro(0.6, rng, length=0.04), b, beat * 4 + 2)
            song.hit("guiro", s.guiro(0.6, rng, length=0.04), b, beat * 4 + 3)
    fill(1, 12)
    band(2, ["Am", "E7"])
    lead(parse("r.16 | r.8 E5.2 D5.2 C5.2 B4.2 |", BAR), 2)
    bar = 4
    band(bar, THEME_CH)
    lead(theme, bar)
    fill(bar + 7, 12)
    bar += 8
    band(bar, THEME_CH)
    lead(theme, bar)
    organ_lead(answers, bar, 0.9)
    fill(bar + 7)
    bar += 8
    band(bar, B_CH, timb=True, pad=False)
    organ_lead(btune, bar)
    organ_lead(btune, bar, 0.5, octave=-12)
    fill(bar + 7, 12)
    bar += 8
    band(bar, THEME_CH, timb=True)
    lead(solo(THEME_CH, rng), bar, 0.95)
    fill(bar + 7)
    bar += 8
    # Break: congas, güiro and timbales alone, bass holding on.
    for i in range(2):
        perc_bar(bar + i, kick=False, timb=True)
        bass_bar(bar + i, "Am", 0.8)
    fill(bar + 1)
    bar += 2
    band(bar, THEME_CH)
    lead(theme, bar)
    organ_lead(theme, bar, 0.55)
    bar += 8
    # Coda: the last two bars of the theme twice, then the final hit.
    tag = [Note(n.start - 6 * BAR, n.length, n.pitches, n.accent) for n in theme if n.start >= 6 * BAR]
    for k in range(2):
        band(bar + 2 * k, ["E7", "Am"])
        lead(tag, bar + 2 * k)
        organ_lead(tag, bar + 2 * k, 0.55)
    fill(bar + 3, 8)
    bar += 4
    assert bar == song.bars, bar
    # Final hit on the downbeat after the last bar: chord, bass, kick, cymbal.
    end = song.at(bar)
    for p in CHORD_TONES["Am"]:
        song.tracks["organ_pad"].add(s.organ(hz(midi(p) + 12), 1.6, 1.4, rng), end)
    song.tracks["rhythm"].add(s.strum([midi(p) + 12 for p in CHORD_TONES["Am"]], 1.5, 1.2, rng, spread=0.02, bright=0.8, decay=1.2, damp=0.3), end)
    song.tracks["lead"].add(guitar(hz(midi("A4")), 1.6, 1.2, rng, bend=True), end)
    song.tracks["bass"].add(s.bass(hz(midi("A1")), 1.2, 1.0, rng, decay=0.8), end)
    song.tracks["kick"].add(s.kick(1.0, rng, f0=55, f1=120, decay=0.3), end)
    song.tracks["timbales"].add(s.cymbal(0.8, rng, decay=1.2), end)
    return song, buses
