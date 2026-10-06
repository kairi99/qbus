# Radio music generator

Six original songs for the bus radio (`src/core/radio.ts`), two per station (each station plays
its pair as a playlist), synthesized from scores written in code. Nothing is sampled: every instrument is additive/subtractive synthesis
and filtered noise (numpy/scipy), so the output is reproducible and free of third-party rights
(CC0, see `public/music/CREDITS.md`).

```sh
pip install -r tools/music/requirements.txt   # numpy, scipy, pyloudnorm, lameenc
python3 tools/music/render.py                 # all six -> public/music/*.mp3 (~10-15 s each)
python3 tools/music/render.py chicha --wav    # one song, plus a WAV in tools/music/out/ (ignored by git)
```

Files:

- `synth.py`: instruments (plucked strings, bowed violin, quena/rondador, Farfisa-style organ,
  tine electric piano, pads, plucks, basses, 808 sub, bombo, kick, snares, claps, hats, shakers,
  güiro, congas, timbales, cowbell, cymbals, risers) and effects (convolution reverb from synthetic impulse responses, spring reverb,
  ping-pong delay, tremolo, sidechain pump, compressor, look-ahead limiter).
- `score.py`: the text notation (`E5.2` = E5 for two sixteenths, `A3+C4+E4.4` a chord, `r.4` a
  rest, `>` an accent, `|` bar lines that are checked), the song timeline, the mixdown, and the
  mastering (high-pass, 2:1 glue compression, -16 LUFS integrated, -1.5 dBFS ceiling), MP3
  encoding (64 kbps joint stereo at 32 kHz: radio quality, and all six fit in about 6 MB).
- `sanjuanito.py`, `sanjuanito2.py`, `chicha.py`, `chicha2.py`, `reggaeton.py`, `reggaeton2.py`:
  the compositions and arrangements (one module per MP3, listed in `render.py`).
- `analyze.py`: objective checks, since we can't listen from here: loudness, peaks, clipping,
  spectral balance, tempo from the onset autocorrelation, average rhythm per sixteenth of the bar
  (low band and high band, to see the bombo/güiro/dembow patterns), and the key (Krumhansl
  profiles). `render.py` prints it for each song.

Each song ends (a final hit and its tail) and the station goes on to its next one, looping the
playlist. The game schedules the broadcast from each song's length, kept in
`src/core/radioStations.ts` (`duration`): update it when a song's length changes
(`tests/radio.test.ts` checks it against the MP3 sizes, and the 6 MB budget).

## What makes each genre recognizable (research notes)

### San Juanito (Ecuador, Andes)

- Indigenous *sanjuan* from the northern Sierra (Otavalo, Imbabura), tied to the Inti Raymi /
  San Juan festivities (June); the mestizo *sanjuanito* became a national genre in the early
  20th century. [1][2][3]
- **Meter and rhythm**: binary, written in **2/4**, a lively dance tempo (allegretto to allegro;
  sources give no single bpm, ~120-130 quarter notes per minute is typical). The recognizable cell
  is a **sixteenth-eighth-sixteenth, eighth-eighth** pattern (short-long-short, long-long), with
  short-short-long figures in the melody. Strings (guitars, bandolines) mark the 2/4, the
  **bombo** accents it: in the mestizo style the bombo plays two quarters, then two eighths and a
  quarter, over two bars. [1][4][5]
- **Melody and harmony**: **pentatonic minor** melodies with mostly two- or four-bar phrases,
  in a **minor key**, alternating with the **relative major** a third up (e.g. E minor <-> G
  major, Em-C-Em-G-Em) rather than Western dominant-tonic cadences; section B often moves to the
  relative major. [1][5]
- **Form**: a short instrumental **estribillo** (intro) that also serves as the interlude between
  sections and as the coda: Intro - A - interlude - B - A - coda. [5]
- **Instruments**: quena, **rondador** (Ecuador's panpipe, often sounding two pipes at once),
  zampoña, charango, bandolín, guitars, violin, harp, **bombo**, seed rattles (*chajchas*);
  modern bands add electric bass, synths and drum kits. [1][2][3]

### Chicha (Peruvian / Andean cumbia)

- Born in the late 1960s in Peru (Lima and the Amazon oil towns; Los Destellos, Juaneco y su
  Combo, Los Mirlos, later Los Shapis, Chacalón): Colombian cumbia played by Andean migrants
  with **huayno** melodies, Cuban percussion and **surf/psychedelic rock** guitar. [6][7]
- **Melody**: built on the Andean **pentatonic** scale (unlike other cumbias), huayno-style
  phrasing with repeated notes and quick runs; **electric lead guitars** (sometimes two or
  three playing at once) take the melodic role, clean but drenched in **reverb/echo**, often
  with wah, tremolo and **wide vibrato**; Farfisa-type **combo organ** or synths double and
  answer the riffs. Rhythm guitar plays **upstrokes on the off-beats**. [6][7][8]
- **Rhythm**: the cumbia groove: **bass on beats 1 and 3** with syncopated pickups (the cumbia
  "bounce"), **güiro** scraping continuously (a long scrape and two short ones per beat),
  **congas** (slap on 2, open tones on 4 and the "and" of 4), **timbales** (shell pattern and
  fills), bongos. Tempo about **90-110 bpm**. [6][8][9]

### Reggaeton

- From Puerto Rico and Panama (1990s), built on the **dembow** riddim (named after Shabba Ranks'
  1990 "Dem Bow"; Jamaican dancehall roots). [10][11]
- **Rhythm**: a **3+3+2 (tresillo)** feel: **kick on every beat**, snare/rim on the last two
  hits of each tresillo, i.e. the sixteenths **4, 7, 12 and 15** of the bar (an extra one on 10
  for variety); hats in eighths with rolls; no swing. **85-100 bpm** (often ~95); Dominican
  dembow is faster (115-130). [10][11][12]
- **Sound and harmony**: deep **808 sub bass** locked to the kick/tresillo, usually a **minor
  key** over a short **four-chord loop** (i-VI-III-VII is a common one), synth pads and
  **plucks** for the hook, reverb/delay throws, risers and drops between sections. [12][13]

### Sources

1. "From Oppression to Opportunity to Expression: Intercultural Relations in Indigenous Musics from the Ecuadorian Andes", *Ethnomusicology Review* 12 (UCLA): <https://ethnomusicologyreview.ucla.edu/journal/volume/12/piece/502>
2. Wikipedia, "Sanjuanito": <https://en.wikipedia.org/wiki/Sanjuanito>
3. Wikipedia, "Music of Ecuador": <https://en.wikipedia.org/wiki/Music_of_Ecuador>
4. Ohio State University Andean Music Ensemble, teachers' guide: <https://clas.osu.edu/sites/default/files/Andean%20Music%20Outreach%20Teachers'%20Guide%20and%20Idea%20Cards.pdf>
5. Universidad de las Américas (Quito) theses on the sanjuanito's rhythm and form: <https://dspace.udla.edu.ec/bitstream/33000/7111/6/UDLA-EC-TLMU-2017-38.pdf>, <https://dspace.udla.edu.ec/bitstream/33000/8581/1/UDLA-EC-TLMU-2018-34.pdf>
6. Wikipedia, "Peruvian cumbia": <https://en.wikipedia.org/wiki/Peruvian_cumbia>
7. Melodigging, "Chicha": <https://www.melodigging.com/genre/chicha>
8. Melodigging, "Cumbia Peruana": <https://www.melodigging.com/genre/cumbia-peruana>
9. Chosic, "Cumbia Peruana" (tempo data): <https://www.chosic.com/genre-chart/cumbia-peruana/>
10. Wikipedia, "Dembow beat": <https://en.wikipedia.org/wiki/Dembow_beat>
11. Open Music Theory, "Drumbeats": <https://viva.pressbooks.pub/openmusictheory/chapter/drumbeats/>
12. bpmcalc, "Reggaeton BPM": <https://bpmcalc.com/genres/reggaeton/>
13. bap.studio, "Dembow (Reggaeton) drum beat": <https://bap.studio/grooves/dembow/>

## The songs

| | San Juanito | Chicha | Reggaeton |
|---|---|---|---|
| Title | Guambrita del Panecillo | Cumbia del Trole Perdido | Perreo en la Ecovía |
| Tempo, meter | 124 bpm, 2/4 | 100 bpm, 4/4 | 94 bpm, 4/4 |
| Key | E minor <-> G major | A minor (C major in B) | F minor, Fm-Db-Ab-Eb |
| Length | 1:54 | 2:03 | 2:16 |
| Form | intro, estribillo, A, estribillo, B, charango solo, breakdown, estribillo, A', B', coda, "tan-tan-taaan" | intro, A, A + organ answers, B (organ), guitar solo, percussion break, A (guitar + organ), coda tag, final hit | filtered intro + riser, hook, verse, pre-hook (no kick, snare roll), hook + countermelody, bridge (no kick), hook, outro, final hit |
| Lead | quena; rondador in parallel thirds | reverb/echo electric guitar with wide vibrato, bends, tremolo; Farfisa-style organ | synth pluck hook (dotted-eighth delay), "sung" synth lead |
| Rhythm section | strummed guitar on the sanjuan cell, charango rasgueo, bass, bombo (q q / 8 8 q), wooden rim, chajchas | upstroke guitar chops, cumbia bass (1, 2&, 3, 4&), güiro, congas, timbales, soft kick | 808 kick on every beat, rim/snare on the dembow, hats, 808 sub on the tresillo, nylon guitar arpeggios, pad pumped by the kick |

The second song of each station is built to sound clearly different from the first while
keeping the genre's markers (meter, rhythm cells, scale, the rhythm section's roles):

| | San Juanito 2 | Chicha 2 | Reggaeton 2 |
|---|---|---|---|
| Title | Neblina en el Pichincha | La Psicodélica del Playón | Bajo la Lluvia de las Cuatro |
| Character | slower, melancholic ("sanjuanito triste") | brisker, psychedelic/Amazonian | romantic, early-2000s "old school" |
| Tempo, meter | 112 bpm, 2/4 | 108 bpm, 4/4 | 90 bpm, 4/4 |
| Key | A minor <-> C major | D minor, A7 as the dominant (F major in B) | B minor, Bm-G-Em-F# (i-VI-iv-V) |
| Length | 1:40 | 1:50 | 2:01 |
| Form | rondador call over the bombo, harp in, estribillo, A, estribillo (rondador), B (C major), harp interlude, A', estribillo/coda, "tan-tan-taaan" | riff intro, A (organ), A + wah answers, B (twin guitars), organ solo, percussion break, A (organ + guitar in octaves), coda, final hit | rain + filtered e-piano intro, hook, verse, hook + harmony, bridge (D-A-G-F#, drums out, rain), hook + countermelody, rain outro, final hit |
| Lead | bowed violin (slides, late vibrato) on the short-long-short cell and dotted sighs; rondador answers and thirds | Farfisa-style organ; wah guitar answers; two guitars in parallel thirds with tremolo-picked long notes | "sung" synth lead with a harmony a third below; a countermelody on top |
| Rhythm section | Andean harp (bass strings on the beats, chord tones on the sanjuan cell), soft brushed guitar, bombo (q q / 8 8 q), chajchas; no charango, no electric bass | palm-muted surf riff, upstroke chops (+ a ghost chop), cumbia bass with a walk-up, güiro, cowbell, congas, timbal cáscara and fills | 808 kick on every beat, rim + real snare on the dembow, timbal fills between sections, 808 sub, tine e-piano on the tresillo, string pads pumped by the kick |

Notes from the analysis: the key finder (chroma above 80 Hz) hears Chicha 2 as A minor, because
the organ theme dwells on A, the dominant; with the bass included D minor edges ahead (0.70 vs
0.69), which suits the genre's modal ambiguity. Reggaeton 2 first used Bm-Em-A-D, which read as
D major (A-D is a V-I); the i-VI-iv-V loop with the A# leading tone made it plainly B minor.

The melodies are new: built from the genre's scale and rhythm cells, not from any existing
tune.
