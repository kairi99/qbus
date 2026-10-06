"""Chicha: "La Psicodélica del Playón" (original). 4/4 at 108 bpm, D minor (F major in B).

Against the first chicha (A minor, guitar lead, organ answers) this one is brisker and turned
around: the Farfisa-style organ sings the theme, the guitar plays a low, palm-muted surf riff
and wah answers, and the B section is two guitars in parallel thirds with tremolo picking on
the long notes (the Amazonian "twin guitar" sound). A cowbell joins the güiro, congas and
timbales, and the harmony leans on the harmonic minor's A7 (the huayno's dominant).

Form: intro (guitar riff, then the band) - A (organ) - A (organ + wah guitar answers) - B (twin
guitars) - organ solo - percussion break - A (organ and guitar in octaves) - coda, final hit.
"""

from __future__ import annotations

import numpy as np

import synth as s
from score import Bus, Note, Song, parse, reverb_bus, transpose
from synth import SR, hz, midi

BAR = 16

CHORD_TONES = {
    "Dm": ["A3", "D4", "F4"],
    "C": ["G3", "C4", "E4"],
    "F": ["A3", "C4", "F4"],
    "A7": ["G3", "C#4", "E4"],
    "Bb": ["Bb3", "D4", "F4"],
    "Gm": ["G3", "Bb3", "D4"],
}
ROOTS = {"Dm": ("D2", "A1"), "C": ("C2", "G1"), "F": ("F1", "C2"), "A7": ("A1", "E2"), "Bb": ("Bb1", "F2"), "Gm": ("G1", "D2")}

THEME = """
r.2 D5.1> D5.1 F5.2 G5.2 A5.4 G5.2 F5.2 | G5.1 A5.1 C6.2 A5.2 G5.2 F5.4 D5.4 |
r.2 C5.1> C5.1 F5.2 G5.2 A5.4 C6.2 A5.2 | G5.2 F5.2 E5.4 C#5.4 E5.4 |
r.2 D5.1> D5.1 F5.2 G5.2 A5.4 G5.2 F5.2 | G5.1 A5.1 C6.2 D6.2 C6.2 A5.4 G5.4 |
F5.2 G5.2 A5.2 G5.2 F5.2 E5.2 C#5.2 E5.2 | D5.8 r.4 A4.1 C5.1 D5.2 |
"""
THEME_CH = ["Dm", "C", "F", "A7", "Dm", "C", "A7", "Dm"]

# The guitar's low riff (palm-muted, staccato), one bar per chord.
RIFF = {
    "Dm": "D4.1 r.1 D4.1 F4.1 A4.2 F4.2 C5.2 A4.2 G4.2 F4.2 |",
    "C": "C4.1 r.1 C4.1 E4.1 G4.2 E4.2 A4.2 G4.2 E4.2 D4.2 |",
    "F": "F4.1 r.1 F4.1 A4.1 C5.2 A4.2 D5.2 C5.2 A4.2 G4.2 |",
    "A7": "E4.1 r.1 E4.1 G4.1 A4.2 C#5.2 E5.2 C#5.2 A4.2 G4.2 |",
}

# Wah guitar answers in the gaps of the organ's second theme.
ANSWERS = """
r.16 | r.12 A4.1> C5.1 D5.2 | r.16 | r.8 E5.2 G5.2 E5.2 C#5.2 |
r.16 | r.12 C5.1> D5.1 F5.2 | r.16 | r.16 |
"""

B_TUNE = """
A5.2> C6.2 A5.2 G5.2 F5.4 G5.4 | A5.2 G5.2 F5.2 D5.2 C5.8 |
D5.2> F5.2 G5.2 A5.2 Bb5.4 A5.4 | G5.2 F5.2 G5.2 A5.2 G5.8 |
A5.2> C6.2 D6.2 C6.2 A5.4 G5.4 | F5.2 G5.2 A5.2 F5.2 D5.8 |
E5.2 F5.2 G5.2 E5.2 C#5.4 E5.4 | D5.12 r.4 |
"""
B_CH = ["F", "C", "Bb", "C", "F", "Dm", "A7", "Dm"]

# D harmonic minor (C# under A7) / F major, for the second guitar's thirds.
SCALE = [2, 4, 5, 7, 9, 10, 0]
PENTA = [midi(n) for n in ("D5", "F5", "G5", "A5", "C6", "D6", "F6", "G6", "A6")]
CHORD_PC = {"Dm": {2, 5, 9}, "C": {0, 4, 7}, "F": {5, 9, 0}, "A7": {9, 1, 4, 7}, "Bb": {10, 2, 5}, "Gm": {7, 10, 2}}


def third_below(m: int) -> int:
    pc = m % 12
    if pc == 1:  # C#: the A below
        return m - 4
    if pc not in SCALE:
        return m - 3
    i = SCALE.index(pc)
    return m - (pc - SCALE[(i - 2) % 7]) % 12


def solo(chords: list[str], rng: np.random.Generator) -> list[Note]:
    """Organ runs: sixteenth motifs on the pentatonic, every other bar ending on a held chord tone,
    with a fast repeated-note figure (the organist's trill) now and then."""
    motifs = [(0, 1, 2, 1), (0, -1, -2, -1), (2, 1, 0, 0), (0, 0, 1, 2), (1, 0, -1, 0), (0, 2, 1, 3), (0, 0, 0, 1)]
    notes: list[Note] = []
    idx = 3
    for b, ch in enumerate(chords):
        for beat in range(4):
            start = b * BAR + beat * 4
            if b % 2 == 1 and beat >= 2:
                if beat == 2:
                    cands = [i for i, p in enumerate(PENTA) if p % 12 in CHORD_PC[ch]] or [idx]
                    idx = min(cands, key=lambda i: abs(i - idx))
                    notes.append(Note(start, 8, [PENTA[idx]], True))
                continue
            m = motifs[rng.integers(len(motifs))]
            for k, d in enumerate(m):
                i = int(np.clip(idx + d, 0, len(PENTA) - 1))
                notes.append(Note(start + k, 1, [PENTA[i]], k == 0))
            idx = int(np.clip(idx + m[-1] + rng.integers(-1, 2), 1, len(PENTA) - 3))
    return notes


def wah(y: np.ndarray, sweep: np.ndarray) -> np.ndarray:
    """A wah pedal: band-passes at three centres crossfaded by `sweep` (0 heel ... 1 toe)."""
    lo = s.sos_filter(y, "bandpass", [350, 900])
    mid = s.sos_filter(y, "bandpass", [700, 1800])
    hi = s.sos_filter(y, "bandpass", [1400, 3600])
    w_lo = np.clip(1 - 2 * sweep, 0, 1)
    w_hi = np.clip(2 * sweep - 1, 0, 1)
    return 2.2 * (w_lo * lo + (1 - w_lo - w_hi) * mid + w_hi * hi)


def build() -> tuple[Song, dict]:
    song = Song("La Psicodélica del Playón", bpm=108, bar_len=BAR, bars=48, seed=1973, tail=3.0)
    rng = song.rng
    room = s.reverb_ir(1.0, rng, predelay=0.008, damp=6500)
    buses = {
        "room": Bus(reverb_bus(room), 0.4),
        "spring": Bus(lambda x: s.spring(s.sos_filter(x, "highpass", 300), rng, 1.8), 0.45),
        # A slapback-ish echo, a dotted sixteenth (the first song's is longer and darker).
        "echo": Bus(lambda x: s.delay(x, 0.75 * 60 / 108 / 2, feedback=0.35, repeats=4, lowpass=3200), 0.4),
    }
    song.track("organ", gain=0.6, pan=0.15, sends={"room": 0.3, "echo": 0.2})
    song.track("organ_pad", gain=0.22, pan=-0.3, sends={"room": 0.4})
    song.track("riff", gain=0.9, pan=-0.3, sends={"spring": 0.35})
    song.track("wah", gain=0.8, pan=0.35, sends={"spring": 0.4, "echo": 0.3})
    song.track("twin1", gain=0.6, pan=-0.35, sends={"spring": 0.45, "echo": 0.25})
    song.track("twin2", gain=0.5, pan=0.35, sends={"spring": 0.45, "echo": 0.25})
    song.track("rhythm", gain=0.85, pan=0.45, sends={"spring": 0.25})
    song.track("bass", gain=0.42)
    song.track("kick", gain=0.32)
    song.track("guiro", gain=1.1, pan=-0.45, sends={"room": 0.15})
    song.track("cowbell", gain=0.9, pan=0.2, sends={"room": 0.15})
    song.track("congas", gain=0.5, pan=0.3, sends={"room": 0.2})
    song.track("timbales", gain=0.55, pan=-0.15, sends={"room": 0.3})

    def rhythm_bar(bar, chord, vel=1.0):
        # Upstroke chops on the off-beats, here with a ghosted chop on the last sixteenth.
        voiced = [midi(p) + 12 for p in CHORD_TONES[chord]]
        for step, v in ((2, 0.8), (6, 1.0), (10, 0.8), (14, 1.0), (15, 0.4)):
            y = s.strum(voiced, song.sixteenth * 0.7, vel * v, rng, spread=0.004, up=True, bright=0.75, decay=0.4, damp=0.02)
            song.hit("rhythm", y, bar, step, jitter=0.003)

    def bass_bar(bar, chord, vel=1.0):
        # The cumbia bass (1, 2&, 3, 4&), with a walk up to the next bar on the last sixteenth.
        root, fifth = ROOTS[chord]
        r, f5 = midi(root), midi(fifth)
        for step, ln, p in ((0, 4, r), (6, 2, f5), (8, 4, r + 12 if r < midi("C2") else r), (14, 1, f5), (15, 1, f5 + 2)):
            song.tracks["bass"].add(s.bass(hz(p), ln * song.sixteenth * 0.85, vel, rng, decay=0.5, tone=0.5), song.at(bar, step) + rng.normal(0, 0.003))

    def perc_bar(bar, vel=1.0, timb=False, kick=True, bell=True):
        for beat in range(4):
            # Güiro: scraaape-chk-chk on every beat.
            song.hit("guiro", s.guiro(vel, rng, length=0.1), bar, beat * 4, jitter=0.003)
            song.hit("guiro", s.guiro(vel * 0.65, rng, length=0.035), bar, beat * 4 + 2, jitter=0.003)
            song.hit("guiro", s.guiro(vel * 0.65, rng, length=0.035), bar, beat * 4 + 3, jitter=0.003)
            if bell:
                # Cowbell on the beats, the mouth (open) on 1 and 3, the heel between.
                song.hit("cowbell", s.cowbell(vel * (0.9 if beat % 2 == 0 else 0.6), rng), bar, beat * 4, jitter=0.002)
        for step, f, stroke, v in ((0, 200, "mute", 0.5), (4, 230, "slap", 0.9), (7, 200, "mute", 0.35), (8, 200, "mute", 0.5), (12, 230, "open", 0.9), (14, 180, "open", 1.0)):
            song.hit("congas", s.conga(vel * v, rng, f, stroke), bar, step, jitter=0.003)
        if kick:
            for step in (0, 8):
                song.hit("kick", s.kick(vel, rng, f0=55, f1=120, decay=0.2, click=0.2, drive=1.4), bar, step)
        if timb:
            for step in (0, 2, 4, 7, 8, 10, 12, 14):
                song.hit("timbales", s.wood(vel * 0.55, rng, freq=1600, decay=0.016), bar, step, jitter=0.003)

    def fill(bar, start=8):
        for i, step in enumerate(range(start, 16)):
            f = 640 if i % 4 < 2 else 450
            song.hit("timbales", s.timbal(0.65 + 0.04 * i, rng, f=f, decay=0.22), bar, step, jitter=0.002)

    def organ_chords(bar, chords, vel=0.7):
        for i, c in enumerate(chords):
            for p in CHORD_TONES[c]:
                song.tracks["organ_pad"].add(s.organ(hz(midi(p) + 12), BAR * song.sixteenth * 0.98, vel, rng, vib_cents=6, bright=0.6), song.at(bar + i))

    def band(bar, chords, timb=False, pad=True):
        for i, c in enumerate(chords):
            rhythm_bar(bar + i, c)
            bass_bar(bar + i, c)
            perc_bar(bar + i, timb=timb)
        if pad:
            organ_chords(bar, chords)

    def guitar(f, dur, vel, bend=False):
        n = int((dur + 0.3) * SR)
        ft = s.vibrato_track(n, f, 6.5, 20 if dur > 0.3 else 0, delay=0.1, rng=rng, scoop_cents=-100 if bend else 0, scoop_t=0.04)
        y = s.pluck(f, dur, vel, rng, bright=0.8, decay=1.6, pos=0.08, damp=0.04, freq_track=ft, tail=0.3)
        return s.softclip(y * 1.8, 1.4) * 0.65

    def riff(bar, chords, vel=1.0):
        # Palm-muted: short, dark notes.
        for i, c in enumerate(chords):
            for n in parse(RIFF[c], BAR):
                y = s.pluck(hz(n.pitches[0] - 12), n.length * song.sixteenth * 0.6, vel * (1 + rng.normal(0, 0.06)), rng, bright=0.45, decay=0.3, pos=0.1, damp=0.03)
                song.tracks["riff"].add(s.softclip(y * 2, 1.5) * 0.6, song.at(bar + i, n.start) + rng.normal(0, 0.003))

    def wah_lead(notes, bar, gain=1.0):
        for n in notes:
            dur = n.length * song.sixteenth * 0.9
            y = guitar(hz(n.pitches[0]), dur, gain * (1.15 if n.accent else 1), bend=n.accent)
            t = s.secs(len(y))
            # Toe down on the pick, rocking back through the note.
            sweep = np.clip(np.minimum(t / 0.04, 1) * np.exp(-t / max(0.12, dur * 0.7)), 0, 1)
            song.tracks["wah"].add(wah(y, sweep), song.at(bar, n.start) + rng.normal(0, 0.003))

    def twin(notes, bar, gain=1.0):
        # Two guitars a third apart; notes of a half bar or more are tremolo-picked (32nds).
        for track, part, g in (("twin1", notes, gain), ("twin2", [Note(n.start, n.length, [third_below(n.pitches[0])], n.accent) for n in notes], gain * 0.85)):
            for n in part:
                f = hz(n.pitches[0])
                if n.length >= 6:
                    picks = n.length * 2
                    for k in range(picks):
                        v = g * (0.75 + 0.25 * (k % 2 == 0)) * (1 - 0.3 * k / picks)
                        y = guitar(f, song.sixteenth * 0.5, v)
                        song.tracks[track].add(y, song.at(bar, n.start + k / 2) + rng.normal(0, 0.002))
                else:
                    y = guitar(f, n.length * song.sixteenth * 0.95, g * (1.15 if n.accent else 1), bend=n.accent and rng.random() < 0.5)
                    song.tracks[track].add(s.tremolo(y, 6.0, 0.2), song.at(bar, n.start) + rng.normal(0, 0.003))

    def organ_lead(notes, bar, gain=1.0, octave=0):
        song.play("organ", s.organ, transpose(notes, octave), bar, gain=gain, legato=0.85, jitter=0.002, vib_cents=14, vib_rate=6.6)

    theme = parse(THEME, BAR)
    # Intro: the riff alone with the güiro, then the band and a timbal fill.
    for b in range(2):
        perc_bar(b, kick=False, bell=False)
    riff(0, ["Dm", "A7"])
    band(2, ["Dm", "A7"], pad=False)
    riff(2, ["Dm", "A7"])
    fill(3, 12)
    bar = 4
    # A: the organ sings, the riff under it.
    band(bar, THEME_CH, pad=False)
    organ_lead(theme, bar)
    riff(bar, THEME_CH, 0.6)
    fill(bar + 7, 12)
    bar += 8
    # A again: wah guitar answers between the organ's phrases.
    band(bar, THEME_CH)
    organ_lead(theme, bar)
    wah_lead(parse(ANSWERS, BAR), bar)
    fill(bar + 7)
    bar += 8
    # B: twin guitars in thirds, timbal cáscara.
    band(bar, B_CH, timb=True)
    twin(parse(B_TUNE, BAR), bar)
    fill(bar + 7, 12)
    bar += 8
    # Organ solo.
    band(bar, THEME_CH, timb=True, pad=False)
    riff(bar, THEME_CH, 0.5)
    organ_lead(solo(THEME_CH, rng), bar, 0.95)
    fill(bar + 7)
    bar += 8
    # Break: congas, güiro, cowbell and timbales; the bass holds the riff's root.
    for i in range(2):
        perc_bar(bar + i, kick=False, timb=True)
        bass_bar(bar + i, "Dm", 0.8)
    fill(bar + 1)
    bar += 2
    # A: organ and guitar in octaves.
    band(bar, THEME_CH, timb=True)
    organ_lead(theme, bar)
    wah_lead(transpose(theme, -12), bar, 0.7)
    bar += 8
    # Coda: the last bar of the theme twice.
    tag = [Note(n.start - 6 * BAR, n.length, n.pitches, n.accent) for n in theme if n.start >= 6 * BAR]
    band(bar, ["A7", "Dm"])
    organ_lead(tag, bar)
    wah_lead(transpose(tag, -12), bar, 0.7)
    fill(bar + 1, 8)
    bar += 2
    assert bar == song.bars, bar
    end = song.at(bar)
    for p in CHORD_TONES["Dm"]:
        song.tracks["organ_pad"].add(s.organ(hz(midi(p) + 12), 1.6, 1.6, rng), end)
    song.tracks["organ"].add(s.organ(hz(midi("D6")), 1.6, 1.0, rng, vib_cents=20), end)
    song.tracks["rhythm"].add(s.strum([midi(p) + 12 for p in CHORD_TONES["Dm"]], 1.5, 1.2, rng, spread=0.02, bright=0.75, decay=1.2, damp=0.3), end)
    song.tracks["twin1"].add(guitar(hz(midi("D5")), 1.6, 1.0, bend=True), end)
    song.tracks["bass"].add(s.bass(hz(midi("D2")), 1.2, 1.0, rng, decay=0.8), end)
    song.tracks["kick"].add(s.kick(1.0, rng, f0=55, f1=120, decay=0.3), end)
    song.tracks["cowbell"].add(s.cowbell(1.0, rng), end)
    song.tracks["timbales"].add(s.cymbal(0.8, rng, decay=1.2), end)
    return song, buses
