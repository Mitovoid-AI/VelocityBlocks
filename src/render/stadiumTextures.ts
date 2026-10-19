// Procedural textures for the grandstands and the perimeter ad boards (fictional names only).

import * as THREE from 'three';
import { canvas, finish, memo, seeded } from './texUtil';

/** One riser of spectators, seen from the track: u along the row (one tile = 8 m), v up the 0.9 m riser. */
export function crowdTexture(): THREE.Texture {
  return memo('crowd', () => {
    const W = 512;
    const H = 128;
    const [c, g] = canvas(W, H);
    const rnd = seeded(5);
    const shirts = ['#e63946', '#f1faee', '#457b9d', '#ffb703', '#2a9d8f', '#e76f51', '#1d3557', '#8338ec', '#fb8500', '#d0d4da'];
    const skins = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
    const hair = ['#2b1d14', '#4a3123', '#111111', '#a0522d', '#d9b26b'];
    // Seat backs.
    g.fillStyle = '#272b31';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#353b44';
    for (let x = 0; x < W; x += 32) g.fillRect(x + 3, 70, 26, 58);
    // About one seat in eight is empty; heights and positions vary a little.
    for (let x = 0; x < W; x += 32) {
      if (rnd() < 0.12) continue;
      const cx = x + 16 + (rnd() - 0.5) * 6;
      const top = 22 + rnd() * 14;
      g.fillStyle = shirts[Math.floor(rnd() * shirts.length)];
      g.beginPath();
      g.moveTo(cx - 13, H);
      g.lineTo(cx - 12, top + 26);
      g.quadraticCurveTo(cx, top + 18, cx + 12, top + 26);
      g.lineTo(cx + 13, H);
      g.closePath();
      g.fill();
      // Arms up for some of them.
      if (rnd() < 0.18) {
        g.fillRect(cx - 14, top - 6, 4, 34);
        g.fillRect(cx + 10, top - 6, 4, 34);
      }
      g.fillStyle = skins[Math.floor(rnd() * skins.length)];
      g.beginPath();
      g.arc(cx, top + 10, 8, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = hair[Math.floor(rnd() * hair.length)];
      g.beginPath();
      g.arc(cx, top + 7, 8, Math.PI, Math.PI * 2);
      g.fill();
    }
    // Shade toward the bottom of the riser (the row in front).
    const shade = g.createLinearGradient(0, H, 0, H - 40);
    shade.addColorStop(0, 'rgba(0,0,0,0.45)');
    shade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = shade;
    g.fillRect(0, H - 40, W, 40);
    return finish(c);
  });
}

const ADS: ReadonlyArray<[string, string, string]> = [
  ['VELOCITY', '#0b1d3a', '#7fd3ff'],
  ['BLOCKS', '#e8452c', '#ffffff'],
  ['TURBO', '#111318', '#ffcf3f'],
  ['NITRO', '#14532d', '#a7f3d0'],
  ['CHECKERED', '#f5f5f5', '#111318'],
];

/** LED boards along the perimeter wall: one tile = 16 m x 2 m. */
export function adBoardTexture(): THREE.Texture {
  return memo('ads', () => {
    const W = 1024;
    const H = 128;
    const [c, g] = canvas(W, H);
    const seg = W / ADS.length;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    ADS.forEach(([text, bg, fg], i) => {
      const x = i * seg;
      g.fillStyle = bg;
      g.fillRect(x, 0, seg, H);
      g.fillStyle = fg;
      g.font = 'bold italic 60px "Segoe UI", Arial, sans-serif';
      g.fillText(text, x + seg / 2, H / 2 + 2, seg - 24);
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(x, 0, 2, H);
    });
    // LED pixel grid.
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
    return finish(c);
  });
}
