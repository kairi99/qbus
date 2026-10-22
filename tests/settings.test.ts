import { describe, expect, it } from 'vitest';
import { DEFAULTS, loadSettings, saveSettings, type KeyValueStore } from '../src/menu/settings';

const memory = (init: Record<string, string> = {}): KeyValueStore => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

describe('settings', () => {
  it('starts from defaults', () => {
    expect(loadSettings(memory())).toEqual(DEFAULTS);
  });

  it('round-trips through storage', () => {
    const store = memory();
    const s = { ...DEFAULTS, bus: 'buseta', zone: 'grid', route: 'ruta-amazonas', camera: 'cockpit' as const, volume: 0.3, hills: 2, timeOfDay: 'night' as const, musicVolume: 0.2, radio: 'off' as const };
    saveSettings(s, store);
    expect(loadSettings(store)).toEqual(s);
  });

  it('keeps a save from before the time of day existed, in daylight', () => {
    const { timeOfDay: _, ...old } = DEFAULTS;
    expect(loadSettings(memory({ qbus: JSON.stringify({ ...old, v: 2 }) })).timeOfDay).toBe('day');
  });

  it('shows the tutorial unless it was turned off, also for saves from before it', () => {
    const { tutorial: _, ...old } = DEFAULTS;
    expect(loadSettings(memory({ qbus: JSON.stringify({ ...old, v: 2 }) })).tutorial).toBe(true);
    const store = memory();
    saveSettings({ ...DEFAULTS, tutorial: false }, store);
    expect(loadSettings(store).tutorial).toBe(false);
  });

  it('rains at random unless set otherwise, also for saves from before rain existed', () => {
    const { rain: _, ...old } = DEFAULTS;
    expect(loadSettings(memory({ qbus: JSON.stringify({ ...old, v: 2 }) })).rain).toBe('random');
    const store = memory();
    saveSettings({ ...DEFAULTS, rain: 'off' }, store);
    expect(loadSettings(store).rain).toBe('off');
    expect(loadSettings(memory({ qbus: JSON.stringify({ ...DEFAULTS, rain: 'granizo' }) })).rain).toBe('random');
  });

  it('starts on real hills', () => {
    expect(DEFAULTS.hills).toBe(1);
  });

  it('moves the old default hills (saved before they could be told apart) to the new one', () => {
    const old = memory({ qbus: JSON.stringify({ ...DEFAULTS, hills: 1.3 }) });
    expect(loadSettings(old).hills).toBe(1);
    // A pick of something else is kept, and so is 1.3 picked from now on.
    expect(loadSettings(memory({ qbus: JSON.stringify({ ...DEFAULTS, hills: 2 }) })).hills).toBe(2);
    const store = memory();
    saveSettings({ ...DEFAULTS, hills: 1.3 }, store);
    expect(loadSettings(store).hills).toBe(1.3);
  });

  it('keeps the radio quiet and on a station by default, also for saves from before it', () => {
    expect(DEFAULTS.radio).not.toBe('off');
    expect(DEFAULTS.musicVolume).toBeLessThanOrEqual(0.5);
    const { radio: _r, musicVolume: _m, ...old } = DEFAULTS;
    const s = loadSettings(memory({ qbus: JSON.stringify({ ...old, v: 2 }) }));
    expect(s.radio).toBe(DEFAULTS.radio);
    expect(s.musicVolume).toBe(DEFAULTS.musicVolume);
  });

  it('keeps the race setup, and its defaults for saves from before it or garbage', () => {
    const store = memory();
    const race = { track: 'papallacta', rivals: 2, rivalBus: 'same', skill: 'hard' as const, traffic: true, slides: false };
    saveSettings({ ...DEFAULTS, mode: 'race', race }, store);
    expect(loadSettings(store).mode).toBe('race');
    expect(loadSettings(store).race).toEqual(race);
    const { race: _, ...old } = DEFAULTS;
    expect(loadSettings(memory({ qbus: JSON.stringify({ ...old, v: 2 }) })).race).toEqual(DEFAULTS.race);
    const bad = loadSettings(memory({ qbus: JSON.stringify({ ...DEFAULTS, race: { rivals: 9, skill: 'god', traffic: 'yes', rivalBus: 3 } }) })).race;
    expect(bad).toEqual(DEFAULTS.race);
    // A race setup saved before landslides existed: they are on.
    const { slides: _s, ...oldRace } = race;
    expect(loadSettings(memory({ qbus: JSON.stringify({ ...DEFAULTS, v: 3, race: oldRace }) })).race).toEqual({ ...oldRace, slides: true });
  });

  it('ignores garbage and out-of-range values', () => {
    const store = memory({ qbus: JSON.stringify({ volume: 7, hills: -3, camera: 'drone', bus: 42, timeOfDay: 'noon', radio: 'salsa', musicVolume: -1 }) });
    const s = loadSettings(store);
    expect(s.radio).toBe(DEFAULTS.radio);
    expect(s.musicVolume).toBe(DEFAULTS.musicVolume);
    expect(s.volume).toBe(1);
    expect(s.hills).toBe(DEFAULTS.hills);
    expect(s.camera).toBe(DEFAULTS.camera);
    expect(s.bus).toBe(DEFAULTS.bus);
    expect(s.timeOfDay).toBe('day');
    expect(loadSettings(memory({ qbus: '{not json' }))).toEqual(DEFAULTS);
  });

  it('online name: empty by default, kept when saved, cleaned, and v2 saves load with the default', () => {
    expect(loadSettings(memory()).online).toEqual({ name: '' });
    const store = memory();
    saveSettings({ ...DEFAULTS, online: { name: 'Ana' } }, store);
    expect(loadSettings(store).online.name).toBe('Ana');
    expect(loadSettings(memory({ qbus: JSON.stringify({ ...DEFAULTS, online: { name: '  ' + 'x'.repeat(30) + '  ' } }) })).online.name).toBe('x'.repeat(16));
    const { online: _, ...old } = DEFAULTS;
    expect(loadSettings(memory({ qbus: JSON.stringify({ ...old, v: 2, hills: 1.3 }) })).online.name).toBe('');
    expect(loadSettings(memory({ qbus: JSON.stringify({ ...old, v: 3, hills: 1.3 }) })).hills).toBe(1.3);
  });
});
