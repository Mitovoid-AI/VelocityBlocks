// Vehicle classes: the Car (every campaign author time before round 3), the Bike and the Truck.
// Dependency-free, like cars.ts: physics, rendering, storage and the UI all import it.

import { VEHICLE_REV } from './constants';

export type VehicleClass = 'car' | 'bike' | 'truck';

export const VEHICLE_CLASSES: readonly VehicleClass[] = ['car', 'bike', 'truck'];

export const VEHICLE_LABEL: Record<VehicleClass, string> = { car: 'Car', bike: 'Bike', truck: 'Truck' };

export const DEFAULT_VEHICLE: VehicleClass = 'car';

/**
 * Classes that need the Full Game (the Google Play in-app purchase, see app/fullGame.ts). The Car is
 * always free and is what a locked class falls back to. Web and portal builds ignore this (all unlocked).
 */
export const PREMIUM_VEHICLES: ReadonlySet<VehicleClass> = new Set<VehicleClass>(['bike', 'truck']);

export function isVehicleClass(v: unknown): v is VehicleClass {
  return typeof v === 'string' && (VEHICLE_CLASSES as readonly string[]).includes(v);
}

/** Suffix that marks wall-mode keys. */
const WALLS_TAG = '|w';

/**
 * A class and its tuning revision as used in keys: '' for the car (its keys predate classes), else
 * the class and its VEHICLE_REV ('bike1'). A retune bumps the revision, so the class's old records,
 * ghosts and custom-track author times stop matching without any migration.
 */
export function vehicleTag(vehicle: VehicleClass): string {
  return vehicle === 'car' ? '' : `${vehicle}${VEHICLE_REV[vehicle] || ''}`;
}

/**
 * Records, ghosts and medals are kept per vehicle class and per wall mode: the car on open roads
 * keeps the plain key ('c:A01'), others get suffixes ('c:A01@bike1', 'c:A01|w', 'c:A01@truck1|w').
 * Track keys ('c:<id>', 'u:<base36 layout hash>') never contain '@' or '|'.
 */
export function entryKey(base: string, vehicle: VehicleClass, walls: boolean): string {
  const tag = vehicleTag(vehicle);
  return `${base}${tag ? `@${tag}` : ''}${walls ? WALLS_TAG : ''}`;
}

/** The track's own key in an entry key ('c:A01@bike1|w' -> 'c:A01'): unlocks are shared by every class and wall mode. */
export function entryBase(key: string): string {
  const k = key.endsWith(WALLS_TAG) ? key.slice(0, -WALLS_TAG.length) : key;
  const at = k.lastIndexOf('@');
  return at > 0 ? k.slice(0, at) : k;
}

/** The wall mode an entry key was made for. */
export const isWallsKey = (key: string): boolean => key.endsWith(WALLS_TAG);
