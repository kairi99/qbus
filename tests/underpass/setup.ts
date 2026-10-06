import * as THREE from 'three';
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { createWorld, initRapier } from '../../src/physics/world';
import { buildCity } from '../../src/world/cityBuilder';
import type { CityData } from '../../src/world/cityData';
import { type RoadGraph, buildRoadGraph } from '../../src/world/roadGraph';
import { type Structure, catalog, loadCity } from './catalog';

export interface Built {
  city: CityData;
  graph: RoadGraph;
  world: RAPIER_T.World;
  scene: THREE.Scene;
  structures: Structure[];
}

/** City data, graph and catalog (no physics): cheap, usable at collection time. */
export function cityAndCatalog(zone = 'mariscal') {
  const city = loadCity(zone);
  const graph = buildRoadGraph(city);
  return { city, graph, structures: catalog(city, graph) };
}

/** The whole city built into a fresh Rapier world and scene. */
export async function buildAll(base = cityAndCatalog()): Promise<Built> {
  await initRapier();
  const world = createWorld();
  const scene = new THREE.Scene();
  buildCity(base.city, world, scene, base.graph);
  world.step(); // fills the query pipeline
  return { ...base, world, scene };
}
