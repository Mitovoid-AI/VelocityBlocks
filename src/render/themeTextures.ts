// Procedural textures for the Desert and Water themes (the Stadium's are in textures.ts): sand for the
// desert floor and embankments, the themes' kerbs and barrier bands, and the tiling noise the water shader
// ripples with. Same rules as textures.ts: memoized, drawn on canvas, a white placeholder without a DOM.

import * as THREE from 'three';
import { canvas, finish, memo, noiseField, seeded } from './texUtil';

/** Desert floor: warm sand with wind ripples and darker drifts (one tile = 64 m, as the lawn). */
export function sandTexture(): THREE.Texture {
  return memo('sand', () => {
    const S = 512;
    const [c, g] = canvas(S, S);
    const rnd = seeded(61);
    const fine = noiseField(S, S, 4, rnd);
    const blot = noiseField(S, S, 64, rnd);
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        // Ripples: bands across the tile, bent by the large noise so they never look ruled.
        const r = Math.sin((y + blot[i] * 60) * ((Math.PI * 2) / 16)) * 0.5 + 0.5;
        const k = 0.9 + (fine[i] - 0.5) * 0.1 + (blot[i] - 0.5) * 0.14 - r * 0.035 + (rnd() - 0.5) * 0.05;
        img.data[i * 4] = 222 * k;
        img.data[i * 4 + 1] = 184 * k;
        img.data[i * 4 + 2] = 132 * k;
        img.data[i * 4 + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return finish(c);
  });
}

/** Packed sand and sandstone for desert embankment sides (one tile = 6 m, as the turf). */
export function sandBankTexture(): THREE.Texture {
  return memo('sand-bank', () => {
    const S = 256;
    const [c, g] = canvas(S, S);
    const rnd = seeded(67);
    const fine = noiseField(S, S, 4, rnd);
    const blot = noiseField(S, S, 32, rnd);
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        // Horizontal strata, as in the mesas.
        const band = Math.sin((y + blot[i] * 20) * 0.11) * 0.5 + 0.5;
        const k = 0.82 + (fine[i] - 0.5) * 0.25 + (blot[i] - 0.5) * 0.2 + band * 0.08;
        img.data[i * 4] = (196 + 20 * band) * k;
        img.data[i * 4 + 1] = (142 + 6 * band) * k;
        img.data[i * 4 + 2] = (92 - 8 * band) * k;
        img.data[i * 4 + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return finish(c);
  });
}

/** Kerb blocks in two colours, laid out as kerbTexture (u across, one tile = 4 m, two blocks). */
function kerb(key: string, a: string, b: string, seed: number): THREE.Texture {
  return memo(key, () => {
    const [c, g] = canvas(128, 256);
    const rnd = seeded(seed);
    g.fillStyle = a;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = b;
    g.fillRect(0, 128, 128, 128);
    g.fillStyle = 'rgba(0,0,0,0.2)';
    g.fillRect(0, 0, 128, 2);
    g.fillRect(0, 128, 128, 2);
    const bevel = g.createLinearGradient(0, 0, 18, 0);
    bevel.addColorStop(0, 'rgba(0,0,0,0.3)');
    bevel.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bevel;
    g.fillRect(0, 0, 18, 256);
    for (let n = 0; n < 2600; n++) {
      g.fillStyle = `rgba(70,50,30,${rnd() * 0.16})`;
      g.fillRect(rnd() * 128, rnd() * 256, 1 + rnd() * 2, 1 + rnd() * 3);
    }
    return finish(c);
  });
}

/** Desert kerbs: terracotta and sand. */
export function desertKerbTexture(): THREE.Texture {
  return kerb('kerb-desert', '#c8572b', '#ead6a6', 71);
}

/** Coastal kerbs: sea blue and white. */
export function waterKerbTexture(): THREE.Texture {
  return kerb('kerb-water', '#1c7fc4', '#f4f6f8', 73);
}

/** Barrier band as barrierTexture, with the stripe in the theme's colour. v = 0 is the deck. */
function barrier(key: string, panel: string, stripe: string, seed: number): THREE.Texture {
  return memo(key, () => {
    const [c, g] = canvas(512, 128);
    const rnd = seeded(seed);
    g.fillStyle = panel;
    g.fillRect(0, 0, 512, 128);
    g.fillStyle = stripe;
    g.fillRect(0, 40, 512, 48);
    g.fillStyle = 'rgba(255,255,255,0.9)';
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
    }
    const grime = g.createLinearGradient(0, 128, 0, 84);
    grime.addColorStop(0, 'rgba(90,64,40,0.4)');
    grime.addColorStop(1, 'rgba(90,64,40,0)');
    g.fillStyle = grime;
    g.fillRect(0, 84, 512, 44);
    for (let n = 0; n < 160; n++) {
      g.fillStyle = `rgba(40,30,20,${0.05 + rnd() * 0.12})`;
      g.fillRect(rnd() * 512, 70 + rnd() * 58, 4 + rnd() * 26, 1 + rnd() * 2);
    }
    return finish(c);
  });
}

export function desertBarrierTexture(): THREE.Texture {
  return barrier('barrier-desert', '#f1e6cf', '#d9692a', 79);
}

export function waterBarrierTexture(): THREE.Texture {
  return barrier('barrier-water', '#f2f5f7', '#11a3b5', 83);
}

/**
 * Tiling ripple noise for the water shader (linear data): R a broad swell, G a finer chop. The shader
 * samples it at two scales and drifts, so it never repeats visibly at the speeds cars go.
 */
export function waterNoiseTexture(): THREE.Texture {
  return memo('water-noise', () => {
    const S = 256;
    const [c, g] = canvas(S, S);
    const rnd = seeded(89);
    const a = noiseField(S, S, 32, rnd);
    const b = noiseField(S, S, 8, rnd);
    const img = g.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      img.data[i * 4] = a[i] * 255;
      img.data[i * 4 + 1] = b[i] * 255;
      img.data[i * 4 + 2] = 128;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return finish(c, true, false);
  });
}
