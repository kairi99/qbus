import { describe, expect, it } from 'vitest';
import { STATIONS, livePosition, nextStation, parseRadio, stationById } from '../src/core/radioStations';

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
    const st = { offset: 30 };
    expect(livePosition(0, st, 100)).toBe(30);
    expect(livePosition(50, st, 100)).toBe(80);
    // Loops at the end of the song.
    expect(livePosition(75, st, 100)).toBe(5);
    expect(livePosition(1000.5, st, 100)).toBeCloseTo(30.5);
    // Tuning away and back later: the song moved on by the time spent away.
    expect(livePosition(20, st, 100) - livePosition(10, st, 100)).toBe(10);
    expect(livePosition(10, st, 0)).toBe(0);
    expect(livePosition(10, st, NaN)).toBe(0);
  });

  it('starts each station at a different point of its song', () => {
    expect(new Set(STATIONS.map((s) => s.offset)).size).toBe(STATIONS.length);
  });

  it('has a song, an artist and a file for every station', () => {
    for (const s of STATIONS) {
      expect(s.name && s.song && s.artist && s.tagline).toBeTruthy();
      expect(s.file).toMatch(/\.mp3$/);
      expect(stationById(s.id)).toBe(s);
    }
    expect(stationById('off')).toBeNull();
  });

  it('reads only known stations from settings', () => {
    expect(parseRadio('chicha')).toBe('chicha');
    expect(parseRadio('off')).toBe('off');
    expect(parseRadio('salsa')).toBeNull();
    expect(parseRadio(3)).toBeNull();
  });
});
