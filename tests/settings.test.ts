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
