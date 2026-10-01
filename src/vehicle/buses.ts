import type { BusPreset } from './busPreset';
import popular from '../../data/buses/popular.json';
import interparroquial from '../../data/buses/interparroquial.json';
import buseta from '../../data/buses/buseta.json';
import ae86 from '../../data/buses/ae86.json';

/** Selectable buses, in menu order, with a one-line pitch each. */
export const BUSES: { preset: BusPreset; blurb: string }[] = [
  { preset: popular as BusPreset, blurb: 'El de toda la vida: ni muy rápido ni muy lento' },
  { preset: interparroquial as BusPreset, blurb: 'Grandote y veloz, pero le cuesta arrancar' },
  { preset: buseta as BusPreset, blurb: 'Chiquita y ágil, derrapa en cualquier esquina' },
];

/** Cars: free roam only (a car carries no passengers on a route). */
export const CARS: { preset: BusPreset; blurb: string }[] = [
  { preset: ae86 as BusPreset, blurb: 'El 86 del tofu: liviano, rapidísimo y nacido para derrapar' },
];

/** Everything drivable in free roam. */
export const VEHICLES = [...BUSES, ...CARS];

export function busById(id: string): BusPreset {
  return (VEHICLES.find((b) => b.preset.id === id) ?? BUSES[0]).preset;
}

/** 0..1 ratings for the menu bars, relative to the other vehicles shown (`pool`). */
export function busStats(p: BusPreset, pool: BusPreset[] = BUSES.map((b) => b.preset)): { label: string; value: number }[] {
  const all = pool;
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
