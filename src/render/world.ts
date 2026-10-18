// Renderer, sky, lighting, stadium surroundings and the current track's meshes.

import * as THREE from 'three';
import type { Track } from '../track/track';
import { grassTexture, standTexture } from './textures';
import { buildTrackVisual, type TrackVisual } from './trackMesh';

export type Quality = 'low' | 'medium' | 'high';

const SKY_TOP = new THREE.Color('#2f6fd6');
const SKY_HORIZON = new THREE.Color('#cfe6ff');

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.3, 4000);
  readonly sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  private readonly hemi = new THREE.HemisphereLight(0xcfe6ff, 0x4a7a3a, 1.05);
  private env = new THREE.Group();
  trackVisual: TrackVisual | null = null;
  private quality: Quality = 'high';

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = SKY_HORIZON.clone();
    this.scene.fog = new THREE.Fog(SKY_HORIZON.getHex(), 400, 2600);
    this.scene.add(this.hemi);
    this.sun.position.set(-120, 220, 90);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -90;
    sc.right = 90;
    sc.top = 90;
    sc.bottom = -90;
    sc.near = 10;
    sc.far = 600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.buildSky());
    this.scene.add(this.env);
    this.resize();
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const dpr = Math.min(window.devicePixelRatio || 1, q === 'high' ? 2 : q === 'medium' ? 1.5 : 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.shadowMap.enabled = q !== 'low';
    this.sun.castShadow = q !== 'low';
    this.sun.shadow.mapSize.set(q === 'high' ? 2048 : 1024, q === 'high' ? 2048 : 1024);
    this.sun.shadow.map?.dispose();
    (this.sun.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
    this.resize();
  }

  get currentQuality(): Quality {
    return this.quality;
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  setTrack(track: Track | null): void {
    if (this.trackVisual) {
      this.scene.remove(this.trackVisual.group);
      this.trackVisual.dispose();
      this.trackVisual = null;
    }
    this.scene.remove(this.env);
    disposeTree(this.env);
    this.env = new THREE.Group();
    this.scene.add(this.env);
    if (!track) {
      this.buildStadium(0, 0, 1024, 1024);
      return;
    }
    this.trackVisual = buildTrackVisual(track);
    this.scene.add(this.trackVisual.group);
    const e = track.extents();
    this.buildStadium(e.x0, e.z0, e.x1, e.z1);
  }

  /** Keep the shadow camera centred on the action. */
  focusShadow(x: number, y: number, z: number): void {
    this.sun.position.set(x - 120, y + 220, z + 90);
    this.sun.target.position.set(x, y, z);
  }

  update(dt: number): void {
    this.trackVisual?.update(dt);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private buildSky(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(3500, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: SKY_TOP },
        horizon: { value: SKY_HORIZON },
        sunDir: { value: new THREE.Vector3(-120, 220, 90).normalize() },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 c = mix(horizon, top, pow(h, 0.55));
          float s = max(dot(normalize(vDir), sunDir), 0.0);
          c += vec3(1.0, 0.92, 0.75) * (pow(s, 600.0) * 2.0 + pow(s, 12.0) * 0.18);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    return sky;
  }

  private buildStadium(x0: number, z0: number, x1: number, z1: number): void {
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const w = x1 - x0;
    const d = z1 - z0;

    // Lawn inside the stadium plus a wide outer field.
    const grass = grassTexture().clone();
    grass.needsUpdate = true;
    grass.repeat.set(w / 64, d / 64);
    const lawn = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ map: grass, roughness: 1 }),
    );
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.set(cx, 0, cz);
    lawn.receiveShadow = true;
    this.env.add(lawn);
    const outer = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.MeshStandardMaterial({ color: 0x5c8f45, roughness: 1 }),
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.set(cx, -0.05, cz);
    this.env.add(outer);

    // Grandstands along the four sides.
    const standMat = new THREE.MeshStandardMaterial({ map: standTexture(), roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xe8ebef, roughness: 0.5, metalness: 0.2 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x30353d, roughness: 0.8 });
    const sides: [number, number, number, number][] = [
      [cx, z0 - 6, w, 0],
      [cx, z1 + 6, w, Math.PI],
      [x0 - 6, cz, d, Math.PI / 2],
      [x1 + 6, cz, d, -Math.PI / 2],
    ];
    for (const [px, pz, len, rot] of sides) {
      const g = new THREE.Group();
      g.position.set(px, 0, pz);
      g.rotation.y = rot;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(len + 12, 3, 1), wallMat);
      wall.position.set(0, 1.5, 6);
      g.add(wall);
      const tex = standMat.map!.clone();
      tex.needsUpdate = true;
      tex.repeat.set(len / 40, 1);
      const stand = new THREE.Mesh(
        new THREE.BoxGeometry(len + 12, 18, 30),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }),
      );
      stand.position.set(0, 9, -10);
      stand.rotation.x = -0.55;
      g.add(stand);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 12, 1, 26), roofMat);
      roof.position.set(0, 26, -12);
      roof.rotation.x = 0.08;
      g.add(roof);
      // Light towers.
      for (let t = -len / 2; t <= len / 2 + 1; t += Math.max(120, len / 4)) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.2, 46, 8), wallMat);
        pole.position.set(t, 23, -30);
        g.add(pole);
        const lamp = new THREE.Mesh(
          new THREE.BoxGeometry(10, 4, 1.5),
          new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6d0, emissiveIntensity: 0.9 }),
        );
        lamp.position.set(t, 47, -29);
        g.add(lamp);
      }
      this.env.add(g);
    }

    // Distant hills for a horizon line.
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x6f9a5a, roughness: 1, flatShading: true });
    for (let n = 0; n < 18; n++) {
      const a = (n / 18) * Math.PI * 2;
      const r = Math.max(w, d) * 0.5 + 900 + (n % 3) * 160;
      const hill = new THREE.Mesh(new THREE.ConeGeometry(260 + (n % 4) * 60, 140 + (n % 5) * 40, 7), hillMat);
      hill.position.set(cx + Math.cos(a) * r, 40, cz + Math.sin(a) * r);
      this.env.add(hill);
    }
  }
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      c.geometry.dispose();
      (Array.isArray(c.material) ? c.material : [c.material]).forEach((m: THREE.Material) => {
        const mm = m as THREE.MeshStandardMaterial;
        if (mm.map && mm.map !== grassTexture() && mm.map !== standTexture()) mm.map.dispose();
        m.dispose();
      });
    }
  });
}
