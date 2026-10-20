// One entry point for every vehicle class's mesh: procedural (Classic) or a loaded realistic model.
// Car body styles apply to procedural cars only.

import { DEFAULT_CAR_BODY, type CarBody } from '../core/cars';
import { isModelId, vehicleModel, type ModelId } from '../core/vehicleModels';
import type { VehicleClass } from '../core/vehicles';
import { buildBike } from './bikeMesh';
import { buildCar, type CarVisual } from './carMesh';
import { readyModel } from './modelCache';
import { instantiate } from './modelVisual';
import { buildTruck } from './truckMesh';

/**
 * The vehicle's mesh. A realistic `model` of the same class is drawn when it is already loaded
 * (modelCache.ts); otherwise, or for an unknown id, the procedural vehicle stands in.
 */
export function buildVehicle(
  vehicle: VehicleClass,
  color: string,
  ghost = false,
  body: CarBody = DEFAULT_CAR_BODY,
  model: ModelId | null = null,
): CarVisual {
  if (model && isModelId(model) && vehicleModel(model).cls === vehicle) {
    const tpl = readyModel(model);
    if (tpl) return instantiate(tpl, color, ghost);
  }
  if (vehicle === 'bike') return buildBike(color, ghost);
  if (vehicle === 'truck') return buildTruck(color, ghost);
  return buildCar(color, ghost, body);
}
