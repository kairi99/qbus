/**
 * Known underpass/bridge bugs, keyed by the exact test name. A test listed here runs as
 * `it.fails`: it stays green while the bug is there and turns red once someone fixes it, so the
 * fixer deletes the entry (that's the "flip"). Run with QBUS_STRICT=1 to run them as ordinary
 * tests and see the real failure messages.
 *
 * Each entry says what was observed when it was added. Never add an entry to make a test pass
 * that broke because of a new change: that's a regression, fix it.
 */
import { it } from 'vitest';

export const KNOWN_BUGS: Record<string, string> = {};

const strict = !!process.env.QBUS_STRICT;

/** `it`, or `it.fails` for a known bug (unless QBUS_STRICT is set). */
export function check(name: string, fn: () => void | Promise<void>, timeout?: number): void {
  if (KNOWN_BUGS[name] && !strict) it.fails(name, fn, timeout);
  else it(name, fn, timeout);
}

/** Adds entries (each suite keeps its own list next to it). */
export function known(entries: Record<string, string>): void {
  Object.assign(KNOWN_BUGS, entries);
}
