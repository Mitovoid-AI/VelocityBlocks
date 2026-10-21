// Rasterises the Velocity Blocks logo (same design as public/icon.svg) into the Android and iOS
// launcher icons and splash screens. Dependency-free: shapes are evaluated per pixel with
// supersampling and written as PNG with node:zlib.
//
//   node scripts/make-icons.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- PNG ----------
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba, alpha = true) {
  const ch = alpha ? 4 : 3;
  const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * ch + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = y * (w * ch + 1) + 1 + x * ch;
      raw[d] = rgba[s];
      raw[d + 1] = rgba[s + 1];
      raw[d + 2] = rgba[s + 2];
      if (alpha) raw[d + 3] = rgba[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function pngSize(file) {
  const b = readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

// ---------- Design (512 x 512 logo space) ----------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG_A = hex('#1b2a6b'), BG_B = hex('#0b1020');
const BLUE = hex('#2f6fd6'), CYAN = hex('#3fe0ff');
const ROAD_A = hex('#ff5a36'), ROAD_B = hex('#ffb02e');
const WHITE = [255, 255, 255];
const TAN = Math.tan((-14 * Math.PI) / 180);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function inRoundRect(x, y, x0, y0, w, h, r) {
  const cx = Math.max(x0 + r, Math.min(x, x0 + w - r));
  const cy = Math.max(y0 + r, Math.min(y, y0 + h - r));
  return x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Logo artwork only (no background); returns [r,g,b] or null. */
function art(X, Y) {
  const gy = Y - 270;
  const gx = X - 256 - gy * TAN;
  // White dashes (drawn on top of the road).
  for (const [a, b] of [
    [-120, -40],
    [10, 90],
  ]) {
    const px = Math.max(a, Math.min(b, gx));
    if ((gx - px) ** 2 + (gy - 38) ** 2 <= 25) return WHITE;
  }
  // Road quad: (-170,10) (170,10) (150,70) (-190,70)
  if (gy >= 10 && gy <= 70) {
    const t = (gy - 10) / 60;
    const left = -170 - 20 * t;
    const right = 170 - 20 * t;
    if (gx >= left && gx <= right) return mix(ROAD_A, ROAD_B, (gx + 190) / 360);
  }
  const squares = [
    [-150, BLUE],
    [-46, CYAN],
    [58, BLUE],
  ];
  for (const [x0, col] of squares) if (inRoundRect(gx, gy, x0, -118, 92, 92, 14)) return col;
  return null;
}

function background(X, Y) {
  return mix(BG_A, BG_B, Math.min(1, Math.max(0, (X + Y) / 1024)));
}

/**
 * Render an image. `place` maps pixel (px, py) -> logo space; `shape` decides the background coverage.
 */
function render(w, h, opts) {
  const { ss = 3, bgShape, scale, ox, oy, solidBg } = opts;
  const out = new Uint8Array(w * h * 4);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const fx = px + (sx + 0.5) / ss;
          const fy = py + (sy + 0.5) / ss;
          const X = (fx - ox) / scale;
          const Y = (fy - oy) / scale;
          let col = art(X, Y);
          let cov = col ? 1 : 0;
          if (!col) {
            if (solidBg) {
              col = solidBg;
              cov = 1;
            } else if (bgShape === 'square') {
              col = background(X, Y);
              cov = 1;
            } else if (bgShape === 'rounded' && inRoundRect(X, Y, 0, 0, 512, 512, 112)) {
              col = background(X, Y);
              cov = 1;
            } else if (bgShape === 'circle' && (X - 256) ** 2 + (Y - 256) ** 2 <= 256 * 256) {
              col = background(X, Y);
              cov = 1;
            }
          } else if (bgShape === 'circle' && (X - 256) ** 2 + (Y - 256) ** 2 > 256 * 256) {
            col = null;
            cov = 0;
          }
          if (col) {
            r += col[0];
            g += col[1];
            b += col[2];
          }
          a += cov;
        }
      const n = ss * ss;
      const i = (py * w + px) * 4;
      // Un-premultiply colour by coverage.
      out[i] = a ? Math.round(r / a) : 0;
      out[i + 1] = a ? Math.round(g / a) : 0;
      out[i + 2] = a ? Math.round(b / a) : 0;
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

function write(rel, w, h, opts, alpha = true) {
  const file = join(root, rel);
  writeFileSync(file, png(w, h, render(w, h, opts), alpha));
  console.log(`${rel} ${w}x${h}`);
}

// ---------- Android ----------
const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, size] of Object.entries(densities)) {
  const base = `android/app/src/main/res/mipmap-${d}`;
  if (!existsSync(join(root, base))) continue;
  write(`${base}/ic_launcher.png`, size, size, { bgShape: 'rounded', scale: size / 512, ox: 0, oy: 0 });
  write(`${base}/ic_launcher_round.png`, size, size, { bgShape: 'circle', scale: size / 512, ox: 0, oy: 0 });
  // Adaptive foreground: 108dp canvas, art inside the central 66% safe zone.
  const fg = Math.round((size * 108) / 48);
  const s = (fg * 0.62) / 512;
  write(`${base}/ic_launcher_foreground.png`, fg, fg, { bgShape: 'none', scale: s, ox: (fg - 512 * s) / 2, oy: (fg - 512 * s) / 2 });
}
const splashes = [
  'drawable',
  ...['land', 'port'].flatMap((o) => ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'].map((d) => `drawable-${o}-${d}`)),
];
for (const dir of splashes) {
  const rel = `android/app/src/main/res/${dir}/splash.png`;
  if (!existsSync(join(root, rel))) continue;
  const [w, h] = pngSize(join(root, rel));
  const s = (Math.min(w, h) * 0.5) / 512;
  write(rel, w, h, { ss: 2, solidBg: BG_B, scale: s, ox: (w - 512 * s) / 2, oy: (h - 512 * s) / 2 }, false);
}

// ---------- Web and desktop ----------
// Safari's Add to Home Screen ignores SVG icons and rounds the square itself; the manifest gets a PNG for
// installs that want one; the Windows app (electron-builder) makes its .ico from the 512 px PNG.
write('public/apple-touch-icon.png', 180, 180, { bgShape: 'square', scale: 180 / 512, ox: 0, oy: 0 }, false);
write('public/icon-512.png', 512, 512, { bgShape: 'rounded', scale: 1, ox: 0, oy: 0 });
write('desktop/icon.png', 512, 512, { bgShape: 'rounded', scale: 1, ox: 0, oy: 0 });

// ---------- iOS ----------
const ios = 'ios/App/App/Assets.xcassets';
if (existsSync(join(root, ios))) {
  write(`${ios}/AppIcon.appiconset/AppIcon-512@2x.png`, 1024, 1024, { ss: 2, bgShape: 'square', scale: 2, ox: 0, oy: 0 }, false);
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    const s = (2732 * 0.3) / 512;
    write(`${ios}/Splash.imageset/${f}`, 2732, 2732, { ss: 1, solidBg: BG_B, scale: s, ox: (2732 - 512 * s) / 2, oy: (2732 - 512 * s) / 2 }, false);
  }
}
