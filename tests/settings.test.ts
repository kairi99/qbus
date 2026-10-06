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
});
