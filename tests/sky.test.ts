import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildEnvScene,
  ENV_LIGHT,
  makeBackground,
  makeFog,
  markEnvLit,
  refreshEnvLit,
  SKY,
  SKY_RENDER_ORDER,
  skyMesh,
} from '../src/render/sky';

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe('sky', () => {
  it('fogs towards exactly the sky horizon colour', () => {
    expect(makeFog().color.getHex()).toBe(SKY.horizon.getHex());
    expect(makeBackground().getHex()).toBe(SKY.horizon.getHex());
  });

  it('is colour-managed and kept out of tone mapping, so the horizon meets the fog', () => {
    const m = skyMesh().material as THREE.ShaderMaterial;
    expect(m.toneMapped).toBe(false);
    expect(m.fog).toBe(false);
    expect(m.fragmentShader).toContain('#include <colorspace_fragment>');
    expect(m.uniforms.top.value).toBe(SKY.zenith);
    expect(m.uniforms.horizon.value).toBe(SKY.horizon);
  });

  it('uses the deeper zenith', () => {
    expect(SKY.zenith.getHexString()).toBe('1f63d8');
  });
});

describe('environment scene', () => {
  it('is dark below the horizon, lighter above, with HDR floodlights and no sun disc', () => {
    const scene = buildEnvScene();
    let up = 0, nUp = 0, down = 0, nDown = 0;
    const hdr: THREE.Mesh[] = [];
    scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.MeshBasicMaterial;
      if (m.vertexColors) {
        const pos = o.geometry.attributes.position;
        const col = o.geometry.attributes.color;
        for (let i = 0; i < pos.count; i++) {
          const y = pos.getY(i) / 50;
          const l = luminance(col.getX(i), col.getY(i), col.getZ(i));
          if (y > 0.3) {
            up += l;
            nUp++;
          } else if (y < 0) {
            down += l;
            nDown++;
          }
        }
      } else if (m.color.r > 1) {
        hdr.push(o);
      }
    });
    expect(nUp).toBeGreaterThan(0);
    expect(up / nUp).toBeGreaterThan((down / nDown) * 2);
    expect(hdr.length).toBe(4);
    hdr.forEach((s) => expect(s.position.y).toBe(9));
  });
});

describe('environment on metals', () => {
  afterEach(() => {
    ENV_LIGHT.map = null;
    ENV_LIGHT.intensity = 0.6;
  });

  it('points only metallic materials at the bake, and follows later bakes', () => {
    const metal = new THREE.MeshStandardMaterial({ metalness: 0.45 });
    const rough = new THREE.MeshStandardMaterial({ metalness: 0 });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), metal), new THREE.Mesh(new THREE.BoxGeometry(), rough));
    const bake = new THREE.Texture();
    ENV_LIGHT.map = bake;
    ENV_LIGHT.intensity = 0.7;
    markEnvLit(root);
    expect(metal.envMap).toBe(bake);
    expect(metal.envMapIntensity).toBe(0.7);
    expect(rough.envMap).toBeNull();
    // Context lost: back to no environment until the next bake.
    ENV_LIGHT.map = null;
    refreshEnvLit(root);
    expect(metal.envMap).toBeNull();
  });
});

describe('sky draw order', () => {
  it('draws after every other opaque object, on the far plane, so covered pixels are never shaded', () => {
    const sky = skyMesh();
    const m = sky.material as THREE.ShaderMaterial;
    expect(sky.renderOrder).toBe(SKY_RENDER_ORDER);
    expect(SKY_RENDER_ORDER).toBeGreaterThan(1);
    expect(m.transparent).toBe(false);
    expect(m.depthTest).toBe(true);
    expect(m.vertexShader).toContain('gl_Position.z = gl_Position.w');
  });
});
