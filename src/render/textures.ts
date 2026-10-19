// Procedurally generated textures (no external image assets).

import * as THREE from 'three';
import { canvas, finish, memo, noiseField, seeded } from './texUtil';

const RW = 512;
const RH = 1024;
/** Paint lines across the road tile, in px of RW: left edge, right edge, centre dash. */
const EDGE_L = 40;
const EDGE_R = 462;
const EDGE_W = 10;
const DASH_X = 250;
const DASH_W = 12;

let roadRough: THREE.Texture | null = null;

/** Darkened rubber in the two wheel-track bands (u 0.25-0.4 and 0.6-0.75), 0..1. */
function rubberAt(u: number): number {
  const s = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  return Math.max(s(0.23, 0.29, u) * (1 - s(0.36, 0.42, u)), s(0.58, 0.64, u) * (1 - s(0.71, 0.77, u)));
}

/** Road deck colour and roughness, drawn together so the paint and rubber line up. */
function drawRoad(): THREE.Texture {
  const [c, g] = canvas(RW, RH);
  const [rc, rg] = canvas(RW, RH);
  const rnd = seeded(7);
  const fine = noiseField(RW, RH, 4, rnd);
  const blot = noiseField(RW, RH, 32, rnd);
  const big = noiseField(RW, RH, 128, rnd);
  const img = g.createImageData(RW, RH);
  const rim = rg.createImageData(RW, RH);
  const band = new Float32Array(RW);
  for (let x = 0; x < RW; x++) band[x] = rubberAt(x / RW);
  for (let y = 0; y < RH; y++) {
    for (let x = 0; x < RW; x++) {
      const i = y * RW + x;
      // Aggregate, blotches and large tonal patches, plus the odd light or dark stone.
      let v = 62 + (fine[i] - 0.5) * 24 + (blot[i] - 0.5) * 16 + (big[i] - 0.5) * 12;
      const h = rnd();
      if (h > 0.985) v += 20;
      else if (h < 0.012) v -= 16;
      const rub = band[x] * (0.7 + 0.3 * blot[i]);
      v *= 1 - 0.18 * rub;
      const o = i * 4;
      img.data[o] = v - 3;
      img.data[o + 1] = v;
      img.data[o + 2] = v + 5;
      img.data[o + 3] = 255;
      // Roughness lives in G: dry asphalt about 0.9, polished rubber about 0.75.
      const r = (0.92 - 0.17 * rub + (fine[i] - 0.5) * 0.08) * 255;
      rim.data[o] = rim.data[o + 1] = rim.data[o + 2] = r;
      rim.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  rg.putImageData(rim, 0, 0);

  // Fine cracks (kept off the tile edges so the tile still wraps).
  g.strokeStyle = 'rgba(18,20,24,0.35)';
  g.lineWidth = 1.2;
  for (let n = 0; n < 7; n++) {
    let x = 60 + rnd() * (RW - 120);
    let y = 60 + rnd() * (RH - 120);
    let a = rnd() * Math.PI * 2;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 14; k++) {
      a += (rnd() - 0.5) * 1.2;
      x = Math.min(RW - 20, Math.max(20, x + Math.cos(a) * 6));
      y = Math.min(RH - 20, Math.max(20, y + Math.sin(a) * 6));
      g.lineTo(x, y);
    }
    g.stroke();
  }

  // Paint: white edge lines and centre dashes (2 m dash every 4 m). Paint is smoother than asphalt.
  for (const [ctx, col] of [
    [g, '#e9edf2'],
    [rg, 'rgb(140,140,140)'],
  ] as const) {
    ctx.fillStyle = col;
    ctx.fillRect(EDGE_L, 0, EDGE_W, RH);
    ctx.fillRect(EDGE_R, 0, EDGE_W, RH);
    for (let y = 0; y < RH; y += 256) ctx.fillRect(DASH_X, y + 32, DASH_W, 128);
  }
  // Worn paint: a sprinkle of asphalt showing through the lines.
  g.fillStyle = 'rgba(60,63,70,0.45)';
  for (let n = 0; n < 1400; n++) {
    const k = rnd();
    const x = k < 0.4 ? EDGE_L + rnd() * EDGE_W : k < 0.8 ? EDGE_R + rnd() * EDGE_W : DASH_X + rnd() * DASH_W;
    g.fillRect(x, rnd() * RH, 1 + rnd() * 1.5, 1 + rnd() * 2);
  }
  roadRough = finish(rc, true, false);
  return finish(c);
}

/** Road deck: asphalt with edge lines, centre dashes and rubbered bands. u across (0..1), v along (one tile = 16 m). */
export function roadTexture(): THREE.Texture {
  return memo('road', drawRoad);
}

/** Roughness for the road deck in G, same layout as roadTexture: asphalt 0.9, rubber 0.75, paint 0.55. */
export function roadRoughness(): THREE.Texture {
  return memo('road-rough', () => {
    roadTexture();
    return roadRough!;
  });
}

/** Red and white kerb blocks: u across (0 = road side), v along (one tile = 4 m, two blocks). */
export function kerbTexture(): THREE.Texture {
  return memo('kerb', () => {
    const [c, g] = canvas(128, 256);
    const rnd = seeded(17);
    g.fillStyle = '#d6312b';
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#f2f2f2';
    g.fillRect(0, 128, 128, 128);
    // Seams between blocks and a shaded bevel on the road side.
    g.fillStyle = 'rgba(0,0,0,0.2)';
    g.fillRect(0, 0, 128, 2);
    g.fillRect(0, 128, 128, 2);
    const bevel = g.createLinearGradient(0, 0, 18, 0);
    bevel.addColorStop(0, 'rgba(0,0,0,0.3)');
    bevel.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bevel;
    g.fillRect(0, 0, 18, 256);
    // Tyre rubber and grime.
    for (let n = 0; n < 2600; n++) {
      g.fillStyle = `rgba(30,30,34,${rnd() * 0.18})`;
      g.fillRect(rnd() * 128, rnd() * 256, 1 + rnd() * 2, 1 + rnd() * 3);
    }
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

/** Rough turf without mow stripes, for embankment sides (one tile = 6 m). */
export function turfTexture(): THREE.Texture {
  return memo('turf', () => {
    const S = 256;
    const [c, g] = canvas(S, S);
    const rnd = seeded(23);
    const fine = noiseField(S, S, 4, rnd);
    const blot = noiseField(S, S, 32, rnd);
    const img = g.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const k = 0.78 + (fine[i] - 0.5) * 0.35 + (blot[i] - 0.5) * 0.3 + (rnd() - 0.5) * 0.12;
      // Dry, browner patches where the blotch noise is low.
      const dry = Math.max(0, 0.35 - blot[i]) * 1.6;
      img.data[i * 4] = (78 + 50 * dry) * k;
      img.data[i * 4 + 1] = (142 - 20 * dry) * k;
      img.data[i * 4 + 2] = (56 - 10 * dry) * k;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return finish(c);
  });
}

/** Barrier band: white panels 2 m long with seams and bolts, a blue stripe with reflector chevrons. v = 0 is the deck. */
export function barrierTexture(): THREE.Texture {
  return memo('barrier', () => {
    const [c, g] = canvas(512, 128);
    const rnd = seeded(29);
    g.fillStyle = '#f2f4f7';
    g.fillRect(0, 0, 512, 128);
    g.fillStyle = '#1f6fe0';
    g.fillRect(0, 40, 512, 48);
    g.fillStyle = '#ffffff';
    for (let x = 0; x < 512; x += 64) {
      g.beginPath();
      g.moveTo(x + 14, 46);
      g.lineTo(x + 50, 64);
      g.lineTo(x + 14, 82);
      g.lineTo(x + 30, 64);
      g.closePath();
      g.fill();
    }
    for (let x = 0; x < 512; x += 128) {
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(x, 0, 3, 128);
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillRect(x + 3, 0, 1, 128);
      g.fillStyle = '#8a929c';
      for (const [bx, by] of [
        [10, 18],
        [10, 110],
        [118, 18],
        [118, 110],
      ]) {
        g.beginPath();
        g.arc(x + bx, by, 3, 0, Math.PI * 2);
        g.fill();
      }
    }
    // Road grime toward the deck and faint scuffs.
    const grime = g.createLinearGradient(0, 128, 0, 84);
    grime.addColorStop(0, 'rgba(45,40,34,0.38)');
    grime.addColorStop(1, 'rgba(45,40,34,0)');
    g.fillStyle = grime;
    g.fillRect(0, 84, 512, 44);
    for (let n = 0; n < 160; n++) {
      g.fillStyle = `rgba(20,20,24,${0.05 + rnd() * 0.12})`;
      g.fillRect(rnd() * 512, 70 + rnd() * 58, 4 + rnd() * 26, 1 + rnd() * 2);
    }
    return finish(c);
  });
}

/** Cast concrete for deck sides, underside and pillars: one tile = 4 m, form-tie holes every metre. */
export function concreteTexture(): THREE.Texture {
  return memo('concrete', () => {
    const S = 256;
    const [c, g] = canvas(S, S);
    const rnd = seeded(11);
    const fine = noiseField(S, S, 4, rnd);
    const blot = noiseField(S, S, 64, rnd);
    const img = g.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const v = 150 + (fine[i] - 0.5) * 22 + (blot[i] - 0.5) * 26 + (rnd() - 0.5) * 10;
      img.data[i * 4] = v - 4;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v + 7;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    // Formwork panel joints every 2 m.
    g.fillStyle = 'rgba(0,0,0,0.14)';
    g.fillRect(0, 0, S, 2);
    g.fillRect(0, 128, S, 2);
    g.fillRect(0, 0, 2, S);
    g.fillRect(128, 0, 2, S);
    // Form-tie holes.
    for (let y = 32; y < S; y += 64) {
      for (let x = 32; x < S; x += 64) {
        g.fillStyle = 'rgba(255,255,255,0.25)';
        g.beginPath();
        g.arc(x + 0.6, y + 0.6, 3.4, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgba(40,42,46,0.7)';
        g.beginPath();
        g.arc(x, y, 2.6, 0, Math.PI * 2);
        g.fill();
      }
    }
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

/** Additive glow around a point light (floodlights, car lights): alpha carries the falloff. */
export function haloTexture(): THREE.Texture {
  return memo('halo', () => {
    const [c, g] = canvas(64, 64);
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.12, 'rgba(255,255,255,0.75)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.18)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return finish(c, false);
  });
}

/** Additive glow around a vertical light strip (gate posts): bright core, soft sides and ends. */
export function glowBarTexture(): THREE.Texture {
  return memo('glow-bar', () => {
    const [c, g] = canvas(64, 256);
    const img = g.createImageData(64, 256);
    for (let y = 0; y < 256; y++) {
      const ey = Math.min(1, Math.min(y, 255 - y) / 40);
      for (let x = 0; x < 64; x++) {
        const dx = Math.abs(x + 0.5 - 32) / 32;
        const a = (Math.exp(-dx * dx * 40) * 0.8 + Math.exp(-dx * dx * 6) * 0.35) * ey * ey;
        const o = (y * 64 + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
        img.data[o + 3] = Math.min(255, a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    return finish(c, false);
  });
}

/** Contact shadow under a car: a soft rounded rectangle (alpha), drawn black. */
export function blobTexture(): THREE.Texture {
  return memo('blob', () => {
    const [c, g] = canvas(64, 128);
    const img = g.createImageData(64, 128);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 64; x++) {
        // Distance outside a rounded box, normalised so 0 is the car footprint and 1 the texture edge.
        const px = Math.max(0, Math.abs(x + 0.5 - 32) / 32 - 0.55) / 0.45;
        const py = Math.max(0, Math.abs(y + 0.5 - 64) / 64 - 0.7) / 0.3;
        const d = Math.min(1, Math.hypot(px, py));
        const a = (1 - d * d) * (1 - d * 0.4);
        const o = (y * 64 + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
        img.data[o + 3] = Math.max(0, a) * 255;
      }
    }
    g.putImageData(img, 0, 0);
    return finish(c, false, false);
  });
}

/** Tiling cloud mask for the sky dome (R = cover), linear data. */
export function cloudTexture(): THREE.Texture {
  return memo('clouds', () => {
    const S = 512;
    const [c, g] = canvas(S, S);
    const rnd = seeded(41);
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'lighter';
    // Clusters of soft puffs; each puff is drawn at the wrapped offsets too so the tile repeats.
    for (let k = 0; k < 11; k++) {
      const cx = rnd() * S;
      const cy = rnd() * S;
      const n = 6 + Math.floor(rnd() * 8);
      for (let p = 0; p < n; p++) {
        const x = cx + (rnd() - 0.5) * 90;
        const y = cy + (rnd() - 0.5) * 40;
        const r = 14 + rnd() * 30;
        const a = 0.25 + rnd() * 0.3;
        for (const ox of [-S, 0, S]) {
          for (const oy of [-S, 0, S]) {
            const gx = x + ox;
            const gy = y + oy;
            if (gx + r < 0 || gx - r > S || gy + r < 0 || gy - r > S) continue;
            const grad = g.createRadialGradient(gx, gy, 0, gx, gy, r);
            grad.addColorStop(0, `rgba(255,255,255,${a})`);
            grad.addColorStop(0.6, `rgba(255,255,255,${a * 0.45})`);
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = grad;
            g.fillRect(gx - r, gy - r, r * 2, r * 2);
          }
        }
      }
    }
    g.globalCompositeOperation = 'source-over';
    return finish(c, true, false);
  });
}
