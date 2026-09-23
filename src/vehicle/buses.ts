import type { BusPreset } from './busPreset';
import popular from '../../data/buses/popular.json';
import interparroquial from '../../data/buses/interparroquial.json';
import buseta from '../../data/buses/buseta.json';

/** Selectable buses, in menu order, with a one-line pitch each. */
export const BUSES: { preset: BusPreset; blurb: string }[] = [
  { preset: popular as BusPreset, blurb: 'El de toda la vida: ni muy rápido ni muy lento' },
  { preset: interparroquial as BusPreset, blurb: 'Grandote y veloz, pero le cuesta arrancar' },
  { preset: buseta as BusPreset, blurb: 'Chiquita y ágil, derrapa en cualquier esquina' },
];

export function busById(id: string): BusPreset {
  return (BUSES.find((b) => b.preset.id === id) ?? BUSES[0]).preset;
}

/** 0..1 ratings for the menu bars, relative to the other buses. */
export function busStats(p: BusPreset): { label: string; value: number }[] {
  const all = BUSES.map((b) => b.preset);
  const rel = (f: (b: BusPreset) => number) => {
    const vs = all.map(f);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    return hi === lo ? 0.6 : 0.25 + (0.75 * (f(p) - lo)) / (hi - lo);
  };
  return [
    { label: 'Velocidad', value: rel((b) => b.topSpeedKmh) },
    { label: 'Arranque', value: rel((b) => b.engineForce / b.mass) },
    { label: 'Manejo', value: rel((b) => b.steer.maxAngle / b.body.length) },
    { label: 'Capacidad', value: rel((b) => b.capacity) },
  ];
}
