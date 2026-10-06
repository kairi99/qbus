import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATIONS, nextStation, onAirAt, parseRadio, stationById } from '../src/core/radioStations';

const song = (file: string, duration: number) => ({ file, title: file, artist: 'x', duration });

describe('radio stations', () => {
  it('cycles the dial through every station and back to off', () => {
    const seen = ['off'];
    let s = nextStation('off');
    while (s !== 'off') {
      seen.push(s);
      s = nextStation(s);
    }
    expect(seen).toEqual(['off', ...STATIONS.map((st) => st.id)]);
    expect(nextStation('off', -1)).toBe(STATIONS[STATIONS.length - 1].id);
    expect(nextStation(STATIONS[0].id, -1)).toBe('off');
  });

  it('plays live: each station is where it would be had it never stopped', () => {
    const st = { offset: 30, songs: [song('a', 100)] };
    expect(onAirAt(0, st)!.position).toBe(30);
    expect(onAirAt(50, st)).toMatchObject({ index: 0, position: 80, remaining: 20 });
    // Loops at the end of the song.
    expect(onAirAt(75, st)!.position).toBe(5);
    expect(onAirAt(1000.5, st)!.position).toBeCloseTo(30.5);
    // Tuning away and back later: the song moved on by the time spent away.
    expect(onAirAt(20, st)!.position - onAirAt(10, st)!.position).toBe(10);
    expect(onAirAt(10, { offset: 0, songs: [song('a', 0)] })).toBeNull();
    expect(onAirAt(10, { offset: 0, songs: [song('a', NaN)] })).toBeNull();
    expect(onAirAt(10, { offset: 0, songs: [] })).toBeNull();
  });

  it('plays its playlist back to back, then from the top', () => {
    const st = { offset: 0, songs: [song('a', 100), song('b', 60), song('c', 40)] };
    const at = (t: number) => {
      const a = onAirAt(t, st)!;
      return [a.song.file, a.position];
    };
    expect(at(0)).toEqual(['a', 0]);
    expect(at(99.5)).toEqual(['a', 99.5]);
    expect(at(100)).toEqual(['b', 0]);
    expect(at(130)).toEqual(['b', 30]);
    expect(at(165)).toEqual(['c', 5]);
    // 200 s in all: the playlist starts over.
    expect(at(200)).toEqual(['a', 0]);
    expect(at(-10)).toEqual(['c', 30]);
    // Each song's remaining time leads straight into the next one.
    const a = onAirAt(80, st)!;
    expect(onAirAt(80 + a.remaining, st)).toMatchObject({ index: 1, position: 0 });
  });

  it('starts each station at a different point of its playlist', () => {
    expect(new Set(STATIONS.map((s) => s.offset)).size).toBe(STATIONS.length);
  });

  it('has songs with a title, an artist and a file for every station', () => {
    for (const s of STATIONS) {
      expect(s.name && s.tagline).toBeTruthy();
      expect(s.songs.length).toBeGreaterThanOrEqual(2);
      for (const so of s.songs) {
        expect(so.title && so.artist).toBeTruthy();
        expect(so.file).toMatch(/\.mp3$/);
      }
      expect(stationById(s.id)).toBe(s);
    }
    const files = STATIONS.flatMap((s) => s.songs.map((so) => so.file));
    expect(new Set(files).size).toBe(files.length);
    expect(stationById('off')).toBeNull();
  });

  it("knows each song's real length (the MP3s are 64 kbps CBR), and they fit the size budget", () => {
    let bytes = 0;
    for (const so of STATIONS.flatMap((s) => s.songs)) {
      const size = statSync(`public/music/${so.file}`).size;
      bytes += size;
      expect(Math.abs((size * 8) / 64000 - so.duration)).toBeLessThan(0.5);
    }
    expect(bytes).toBeLessThan(6 * 1024 * 1024);
  });

  it('reads only known stations from settings', () => {
    expect(parseRadio('chicha')).toBe('chicha');
    expect(parseRadio('off')).toBe('off');
    expect(parseRadio('salsa')).toBeNull();
    expect(parseRadio(3)).toBeNull();
  });
});
