// Procedurally generated textures (no external image assets).

import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function finish(c: HTMLCanvasElement, repeat = true, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const cache = new Map<string, THREE.Texture>();
function memo(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = cache.get(key);
  if (!t) cache.set(key, (t = make()));
  return t;
}

/** Road deck: asphalt with edge lines, kerbs and centre dashes. u across (0..1), v along (one tile = 16 m). */
export function roadTexture(): THREE.Texture {
  return memo('road', () => {
    const [c, g] = canvas(256, 512);
    const rnd = seeded(7);
    g.fillStyle = '#3b3f46';
    g.fillRect(0, 0, 256, 512);
    for (let n = 0; n < 9000; n++) {
      const v = 50 + rnd() * 30;
      g.fillStyle = `rgba(${v},${v + 2},${v + 6},${0.35 + rnd() * 0.4})`;
      g.fillRect(rnd() * 256, rnd() * 512, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    // Kerbs (outer 6%) in red/white blocks.
    for (let y = 0; y < 512; y += 64) {
      g.fillStyle = (y / 64) % 2 ? '#f2f2f2' : '#d6312b';
      g.fillRect(0, y, 14, 64);
      g.fillRect(242, y, 14, 64);
    }
    // White edge lines.
    g.fillStyle = '#e9edf2';
    g.fillRect(20, 0, 5, 512);
    g.fillRect(231, 0, 5, 512);
    // Centre dashes.
    g.fillStyle = 'rgba(240,240,240,0.85)';
    for (let y = 0; y < 512; y += 128) g.fillRect(125, y + 16, 6, 64);
    return finish(c);
  });
}

export function grassTexture(): THREE.Texture {
  return memo('grass', () => {
    const [c, g] = canvas(512, 512);
    const rnd = seeded(3);
    // Mowed stripes like a stadium lawn.
    for (let x = 0; x < 512; x += 64) {
      g.fillStyle = (x / 64) % 2 ? '#4f9a3c' : '#5aa845';
      g.fillRect(x, 0, 64, 512);
    }
    for (let n = 0; n < 26000; n++) {
      const v = rnd();
      g.fillStyle = v > 0.5 ? `rgba(40,90,30,${rnd() * 0.35})` : `rgba(140,200,100,${rnd() * 0.25})`;
      g.fillRect(rnd() * 512, rnd() * 512, 1, 2 + rnd() * 3);
    }
    return finish(c);
  });
}

/** Barrier band: white panels with a coloured stripe. */
export function barrierTexture(): THREE.Texture {
  return memo('barrier', () => {
    const [c, g] = canvas(256, 64);
    g.fillStyle = '#f4f6f8';
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = '#1f6fe0';
    g.fillRect(0, 20, 256, 24);
    g.fillStyle = '#ffffff';
    for (let x = 0; x < 256; x += 64) {
      g.beginPath();
      g.moveTo(x + 8, 22);
      g.lineTo(x + 30, 32);
      g.lineTo(x + 8, 42);
      g.lineTo(x + 18, 32);
      g.closePath();
      g.fill();
    }
    g.fillStyle = 'rgba(0,0,0,0.15)';
    for (let x = 0; x < 256; x += 64) g.fillRect(x, 0, 2, 64);
    return finish(c);
  });
}

/** Concrete for deck sides, underside and pillars. */
export function concreteTexture(): THREE.Texture {
  return memo('concrete', () => {
    const [c, g] = canvas(128, 128);
    const rnd = seeded(11);
    g.fillStyle = '#9aa1aa';
    g.fillRect(0, 0, 128, 128);
    for (let n = 0; n < 3000; n++) {
      const v = 130 + rnd() * 50;
      g.fillStyle = `rgba(${v},${v},${v + 6},0.4)`;
      g.fillRect(rnd() * 128, rnd() * 128, 2, 2);
    }
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(0, 0, 128, 2);
    return finish(c);
  });
}

/** Animated chevrons for boost (green) and turbo (red) pads. */
export function padTexture(kind: 'boost' | 'turbo'): THREE.Texture {
  return memo('pad-' + kind, () => {
    const [c, g] = canvas(128, 256);
    const base = kind === 'boost' ? ['#0b3d1a', '#33ff77', '#c8ffd8'] : ['#4a0b0b', '#ff4433', '#ffd2b0'];
    g.fillStyle = base[0];
    g.fillRect(0, 0, 128, 256);
    for (let y = 0; y < 256; y += 64) {
      g.fillStyle = base[1];
      g.beginPath();
      g.moveTo(10, y + 56);
      g.lineTo(64, y + 14);
      g.lineTo(118, y + 56);
      g.lineTo(118, y + 36);
      g.lineTo(64, y - 6);
      g.lineTo(10, y + 36);
      g.closePath();
      g.fill();
    }
    g.strokeStyle = base[2];
    g.lineWidth = 4;
    g.strokeRect(2, 0, 124, 256);
    return finish(c);
  });
}

/** Gate banner text. */
export function bannerTexture(text: string, bg: string, fg: string, checker = false): THREE.Texture {
  return memo(`banner-${text}-${bg}-${checker}`, () => {
    const [c, g] = canvas(512, 96);
    if (checker) {
      for (let y = 0; y < 96; y += 24)
        for (let x = 0; x < 512; x += 24) {
          g.fillStyle = ((x + y) / 24) % 2 ? '#111' : '#f5f5f5';
          g.fillRect(x, y, 24, 24);
        }
      g.fillStyle = 'rgba(0,0,0,0.65)';
      g.fillRect(96, 14, 320, 68);
    } else {
      g.fillStyle = bg;
      g.fillRect(0, 0, 512, 96);
    }
    g.fillStyle = fg;
    g.font = 'bold 60px "Segoe UI", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 256, 50);
    return finish(c, false);
  });
}

/** Soft round sprite for smoke particles. */
export function smokeTexture(): THREE.Texture {
  return memo('smoke', () => {
    const [c, g] = canvas(64, 64);
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return finish(c, false);
  });
}

/** Grandstand seating. */
export function standTexture(): THREE.Texture {
  return memo('stand', () => {
    const [c, g] = canvas(256, 128);
    const rnd = seeded(5);
    const cols = ['#e63946', '#f1faee', '#457b9d', '#ffb703', '#2a9d8f', '#e76f51'];
    g.fillStyle = '#2b2f36';
    g.fillRect(0, 0, 256, 128);
    for (let y = 0; y < 128; y += 8) {
      g.fillStyle = '#3d434c';
      g.fillRect(0, y + 6, 256, 2);
      for (let x = 0; x < 256; x += 6) {
        if (rnd() < 0.7) {
          g.fillStyle = cols[Math.floor(rnd() * cols.length)];
          g.fillRect(x + 1, y + 1, 4, 5);
        }
      }
    }
    return finish(c);
  });
}
