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
    const s = { ...DEFAULTS, bus: 'buseta', zone: 'grid', route: 'ruta-amazonas', camera: 'cockpit' as const, volume: 0.3, hills: 2 };
    saveSettings(s, store);
    expect(loadSettings(store)).toEqual(s);
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

  it('ignores garbage and out-of-range values', () => {
    const store = memory({ qbus: JSON.stringify({ volume: 7, hills: -3, camera: 'drone', bus: 42 }) });
    const s = loadSettings(store);
    expect(s.volume).toBe(1);
    expect(s.hills).toBe(DEFAULTS.hills);
    expect(s.camera).toBe(DEFAULTS.camera);
    expect(s.bus).toBe(DEFAULTS.bus);
    expect(loadSettings(memory({ qbus: '{not json' }))).toEqual(DEFAULTS);
  });
});
