"""Renders the radio songs to public/music/*.mp3 and prints an analysis of each mix.

    python3 tools/music/render.py              # all three
    python3 tools/music/render.py chicha       # one
    python3 tools/music/render.py --wav        # also write 16-bit WAVs to tools/music/out/

Needs numpy, scipy, pyloudnorm and lameenc (`pip install -r tools/music/requirements.txt`).
"""

from __future__ import annotations

import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import analyze  # noqa: E402
import chicha  # noqa: E402
import reggaeton  # noqa: E402
import sanjuanito  # noqa: E402
from score import encode_mp3, master  # noqa: E402
from synth import SR  # noqa: E402

SONGS = {"sanjuanito": sanjuanito, "chicha": chicha, "reggaeton": reggaeton}
OUT = os.path.join(HERE, "..", "..", "public", "music")


def render(name: str, wav: bool) -> None:
    t0 = time.time()
    song, buses = SONGS[name].build()
    mix, levels = song.render(buses)
    pre_peak = 20 * np.log10(np.max(np.abs(mix)) + 1e-12)
    out = master(mix)
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{name}.mp3")
    size = encode_mp3(out, path)
    print(f"\n== {name}: '{song.title}', {song.bpm} bpm, {out.shape[1] / SR:.1f} s, {size / 1024:.0f} KiB -> {os.path.relpath(path)} ({time.time() - t0:.1f} s)")
    print("stems (dBFS rms): " + ", ".join(f"{k} {v:.1f}" for k, v in sorted(levels.items(), key=lambda kv: -kv[1])))
    print(f"raw mix peak {pre_peak:.1f} dBFS")
    analyze.report(out, song)
    if wav:
        import wave

        os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
        with wave.open(os.path.join(HERE, "out", f"{name}.wav"), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((np.clip(out.T, -1, 1) * 32767).astype("<i2").tobytes())


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    for n in args or SONGS:
        render(n, "--wav" in sys.argv)
