import { describe, expect, it } from 'vitest';
import { JITTER, MENU_LEVELS, TickLimiter, clickSound, inputSound, jitter, type ElementLike, type MenuSound } from '../src/menu/menuSoundModel';

const el = (tagName: string, attrs: Record<string, string> = {}): ElementLike => ({ tagName, getAttribute: (n) => attrs[n] ?? null });

describe('menu sounds', () => {
  it('picks a sound for each kind of menu button', () => {
    expect(clickSound(el('BUTTON', { 'data-go': 'setup' }))).toBe('confirm');
    expect(clickSound(el('BUTTON', { 'data-go': 'credits' }))).toBe('confirm');
    expect(clickSound(el('BUTTON', { 'data-go': 'back' }))).toBe('back');
    expect(clickSound(el('BUTTON', { 'data-go': 'play' }))).toBe('start');
    expect(clickSound(el('BUTTON', { 'data-route': 'circuito' }))).toBe('route');
    for (const k of ['data-mode', 'data-bus', 'data-zone']) expect(clickSound(el('BUTTON', { [k]: 'x' }))).toBe('select');
    expect(clickSound(el('BUTTON'))).toBeNull();
  });

  it('radio switches click on change, sliders tick', () => {
    expect(inputSound(el('INPUT', { type: 'radio' }))).toBe('toggle');
    expect(inputSound(el('INPUT', { type: 'range' }))).toBe('slider');
    expect(inputSound(el('INPUT', { type: 'text' }))).toBeNull();
    expect(inputSound(el('LABEL', { type: 'radio' }))).toBeNull();
  });

  it('hover ticks once per element, rate-limited, and hush after a louder sound', () => {
    const t = new TickLimiter(0.06, 0.25);
    const [a, b, c] = [{}, {}, {}];
    expect(t.tick(a, 0)).toBe(true);
    expect(t.tick(a, 0.5)).toBe(false); // same card again (pointer moving over its children)
    expect(t.tick(b, 0.52)).toBe(true);
    expect(t.tick(c, 0.55)).toBe(false); // sweeping fast across a row: not a rattle
    expect(t.tick(a, 0.7)).toBe(true);
    t.loud(1);
    expect(t.tick(b, 1.1)).toBe(false); // the click focused the next screen's first button
    expect(t.tick(c, 1.3)).toBe(true);
    t.leave();
    expect(t.tick(c, 1.5)).toBe(true); // back onto the same option after leaving them all
  });

  it('jitters pitch within each sound\'s range, the slider not at all', () => {
    for (const s of Object.keys(JITTER) as MenuSound[]) {
      expect(jitter(s, 0)).toBeCloseTo(1 - JITTER[s]);
      expect(jitter(s, 0.5)).toBeCloseTo(1);
      expect(jitter(s, 0.999)).toBeLessThanOrEqual(1 + JITTER[s]);
      expect(JITTER[s]).toBeLessThan(0.1);
    }
    expect(jitter('slider', 0.9)).toBe(1);
  });

  it('stays under the game\'s one-shots: hover is the quietest, start the loudest', () => {
    const coin = 0.12; // the game's coin cue peak (square), a few dB over the cruising engine
    const levels = Object.values(MENU_LEVELS);
    for (const v of levels) expect(v).toBeLessThanOrEqual(coin);
    expect(Math.min(...levels)).toBe(MENU_LEVELS.hover);
    expect(Math.max(...levels)).toBe(MENU_LEVELS.start);
    expect(20 * Math.log10(MENU_LEVELS.hover / coin)).toBeLessThan(-9);
  });
});
