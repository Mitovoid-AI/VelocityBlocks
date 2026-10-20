// Reads a realistic model file (meshopt geometry, KTX2 textures) and makes its template. Loaded with a
// dynamic import() the first time a realistic model is wanted, so GLTFLoader, the meshopt decoder and the
// KTX2 loader stay out of the start-up bundle. The Basis transcoder comes from three's own folder (KTX2Loader
// resolves it next to itself; Vite copies it into the build), so it always matches the installed three.

import type * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { VehicleModel } from '../core/vehicleModels';
import { prepareTemplate, type ModelTemplate } from './modelVisual';

let loader: GLTFLoader | null = null;

function gltfLoader(renderer: THREE.WebGLRenderer): GLTFLoader {
  if (loader) return loader;
  // detectSupport picks the GPU's compressed format (ETC2 or ASTC on phones; RGBA where there is none).
  const ktx2 = new KTX2Loader().setWorkerLimit(1).detectSupport(renderer);
  loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/** Load and prepare one model (relative to the page, like every other asset with base './'). */
export async function loadTemplate(model: VehicleModel, renderer: THREE.WebGLRenderer): Promise<ModelTemplate> {
  const gltf = await gltfLoader(renderer).loadAsync(`./${model.file}`);
  return prepareTemplate(gltf.scene, model);
}
