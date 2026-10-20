// The loaded realistic models (templates), and loading them on demand. Building a vehicle never waits:
// buildVehicle draws a model only when its template is ready here, otherwise the procedural vehicle of the
// class. Races wait for the model before they start (App.playRace, with a timeout); the menu car swaps
// when the load finishes. At most KEEP unused templates stay in memory.

import type * as THREE from 'three';
import { vehicleModel, type ModelId } from '../core/vehicleModels';
import type { ModelTemplate } from './modelVisual';

/** Unused templates kept loaded (most recent first), beyond those still drawn. */
const KEEP = 2;

let renderer: THREE.WebGLRenderer | null = null;
const ready = new Map<ModelId, ModelTemplate>();
const pending = new Map<ModelId, Promise<ModelTemplate | null>>();
/** Most recently wanted first. */
let recent: ModelId[] = [];
/** Ids whose load failed this session (offline web build, missing file): not retried until a reload. */
const failed = new Set<ModelId>();

/** The renderer the KTX2 loader checks for compressed texture support (App sets it at start). */
export function setModelRenderer(r: THREE.WebGLRenderer): void {
  renderer = r;
}

/** The template of a model when it is loaded, else null. */
export function readyModel(id: ModelId): ModelTemplate | null {
  return ready.get(id) ?? null;
}

function touch(id: ModelId): void {
  recent = [id, ...recent.filter((x) => x !== id)];
}

/** Free unused templates beyond the KEEP most recently wanted. */
function evict(): void {
  let kept = 0;
  for (const id of recent) {
    const t = ready.get(id);
    if (!t) continue;
    if (t.refs > 0) continue;
    if (++kept <= KEEP) continue;
    ready.delete(id);
    t.dispose();
  }
}

/** Keep a prepared template as loaded (the loader's result; tests hand in templates built from plain scenes). */
export function storeModel(id: ModelId, t: ModelTemplate): void {
  touch(id);
  const old = ready.get(id);
  ready.set(id, t);
  if (old && old !== t && old.refs === 0) old.dispose();
  evict();
}

/** Load a model (once; later calls share the load). Resolves null when it cannot be loaded. */
export function loadModel(id: ModelId): Promise<ModelTemplate | null> {
  touch(id);
  const have = ready.get(id);
  if (have) return Promise.resolve(have);
  if (failed.has(id) || !renderer) return Promise.resolve(null);
  let p = pending.get(id);
  if (p) return p;
  const r = renderer;
  p = import('./modelLoader')
    .then((m) => m.loadTemplate(vehicleModel(id), r))
    .then(
      (t) => {
        storeModel(id, t);
        return t;
      },
      (e: unknown) => {
        console.warn(`Vehicle model ${id} could not be loaded; the classic one stands in.`, e);
        failed.add(id);
        return null;
      },
    )
    .finally(() => pending.delete(id));
  pending.set(id, p);
  return p;
}

/**
 * Wait for a model at most `ms`: true when it is ready. On a timeout the load carries on in the background
 * (the next run will have it); the caller goes ahead with the classic vehicle.
 */
export function ensureModel(id: ModelId, ms: number): Promise<boolean> {
  if (ready.has(id)) {
    touch(id);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void loadModel(id).then((t) => {
      clearTimeout(timer);
      resolve(t !== null);
    });
  });
}
