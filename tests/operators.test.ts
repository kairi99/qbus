import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { OPERATOR_ALIAS, aliasRef } from '../src/world/osm/operators';
import { loadRecords } from '../src/gameplay/records';

describe('bus operators get look-alike names', () => {
  it('swaps the operator, keeps the line number', () => {
    expect(aliasRef('CATAR-061')).toBe('KATAR-061');
    expect(aliasRef('REINO DE QUITO 093')).toBe('REYNO DE KITO 093');
    expect(aliasRef('QUITUMBE 115')).toBe('KITUMBE 115');
    expect(aliasRef('C4')).toBe('C4');
  });

  it('is idempotent: a renamed ref is left alone', () => {
    for (const alias of Object.values(OPERATOR_ALIAS)) expect(aliasRef(`${alias}-001`)).toBe(`${alias}-001`);
  });

  it('no real operator name reaches the city data', () => {
    const city = readFileSync('data/cities/mariscal.json', 'utf8');
    const lines = JSON.stringify(JSON.parse(city).lines).toUpperCase();
    for (const real of Object.keys(OPERATOR_ALIAS)) expect(lines, real).not.toMatch(new RegExp(`(^|[^A-Z])${real}[ -]\\d`));
  });

  it('old records follow their line to its new id', () => {
    const data: Record<string, string> = {
      'qbus.records': JSON.stringify({ v: 2, routes: { 'mariscal/linea-catar-061': { top: [{ cents: 500, stars: 1 }], stars: 1 } }, missions: {} }),
    };
    const store = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
    expect(Object.keys(loadRecords(store).routes)).toEqual(['mariscal/linea-katar-061']);
  });
});
