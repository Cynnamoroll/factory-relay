#!/usr/bin/env node
// One geometry definition renders both the reviewable SVG and the bundled AppIcon.icns,
// so the app icon is reproducible on any machine without design tools or macOS utilities.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const body = { x: 100 / 1024, y: 100 / 1024, w: 824 / 1024, h: 824 / 1024, r: 185 / 1024 };
const gradient = { top: [0x1f, 0x1b, 0x4d], bottom: [0x4f, 0x46, 0xe5] };
const screen = { cx: 0.5, cy: 0.455, hw: 0.265, hh: 0.185, r: 0.05, stroke: 0.045 };
const stand = { cx: 0.5, cy: 0.695, hw: 0.1, hh: 0.022, r: 0.022 };
const cursor = [[0.455, 0.335], [0.455, 0.585], [0.515, 0.53], [0.555, 0.62], [0.592, 0.603], [0.552, 0.515], [0.632, 0.515]];
const orange = [0xfb, 0x92, 0x3c];
const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
const n = v => +v.toFixed(4);

export function appIconSvg() {
  const s = 1024, p = v => n(v * s);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hex(gradient.top)}"/><stop offset="1" stop-color="${hex(gradient.bottom)}"/></linearGradient></defs>
  <rect x="${p(body.x)}" y="${p(body.y)}" width="${p(body.w)}" height="${p(body.h)}" rx="${p(body.r)}" fill="url(#body)"/>
  <rect x="${p(screen.cx - screen.hw)}" y="${p(screen.cy - screen.hh)}" width="${p(2 * screen.hw)}" height="${p(2 * screen.hh)}" rx="${p(screen.r)}" fill="none" stroke="#ffffff" stroke-width="${p(screen.stroke)}"/>
  <rect x="${p(stand.cx - stand.hw)}" y="${p(stand.cy - stand.hh)}" width="${p(2 * stand.hw)}" height="${p(2 * stand.hh)}" rx="${p(stand.r)}" fill="#ffffff"/>
  <polygon points="${cursor.map(([x, y]) => `${p(x)},${p(y)}`).join(' ')}" fill="${hex(orange)}"/>
</svg>
`;
}

const roundedBox = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
function polygon(x, y, points) {
  let d = Infinity, inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i], [bx, by] = points[j];
    const ex = bx - ax, ey = by - ay, wx = x - ax, wy = y - ay;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    d = Math.min(d, Math.hypot(wx - ex * t, wy - ey * t));
    if ((ay > y) !== (by > y) && x < ax + (y - ay) * ex / ey) inside = !inside;
  }
  return inside ? -d : d;
}

/** Renders straight-alpha RGBA pixels with analytic anti-aliasing from signed distances. */
export function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4), px = 1 / size;
  const cover = d => Math.max(0, Math.min(1, 0.5 - d / px));
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    const x = (col + 0.5) / size, y = (row + 0.5) / size;
    const base = cover(roundedBox(x, y, body.x + body.w / 2, body.y + body.h / 2, body.w / 2, body.h / 2, body.r));
    if (!base) continue;
    const t = Math.max(0, Math.min(1, (y - body.y) / body.h));
    let color = gradient.top.map((v, i) => v + (gradient.bottom[i] - v) * t);
    const white = Math.max(
      cover(Math.abs(roundedBox(x, y, screen.cx, screen.cy, screen.hw, screen.hh, screen.r)) - screen.stroke / 2),
      cover(roundedBox(x, y, stand.cx, stand.cy, stand.hw, stand.hh, stand.r)));
    color = color.map(v => v + (255 - v) * white);
    const arrow = cover(polygon(x, y, cursor));
    color = color.map((v, i) => v + (orange[i] - v) * arrow);
    const o = (row * size + col) * 4;
    pixels[o] = Math.round(color[0]); pixels[o + 1] = Math.round(color[1]); pixels[o + 2] = Math.round(color[2]);
    pixels[o + 3] = Math.round(255 * base);
  }
  return pixels;
}

const crcTable = Array.from({ length: 256 }, (_, k) => {
  let c = k;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = data => { let c = 0xffffffff; for (const b of data) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function png(size) {
  const pixels = renderIcon(size), raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row++) pixels.copy(raw, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Apple iconset names and the ICNS element types that carry each PNG.
export const iconset = [
  ['icon_16x16@2x.png', 32, 'ic11'], ['icon_32x32@2x.png', 64, 'ic12'], ['icon_128x128.png', 128, 'ic07'],
  ['icon_128x128@2x.png', 256, 'ic13'], ['icon_256x256.png', 256, 'ic08'], ['icon_256x256@2x.png', 512, 'ic14'],
  ['icon_512x512.png', 512, 'ic09'], ['icon_512x512@2x.png', 1024, 'ic10'],
];
export function appIconIcns() {
  const cache = new Map();
  const elements = iconset.map(([, size, type]) => {
    if (!cache.has(size)) cache.set(size, png(size));
    const data = cache.get(size), head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + elements.reduce((sum, e) => sum + e.length, 0), 4);
  return Buffer.concat([head, ...elements]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2];
  if (!out) throw new Error('Usage: node scripts/app-icon.js OUTPUT_DIRECTORY');
  const set = path.join(out, 'AppIcon.iconset');
  mkdirSync(set, { recursive: true });
  for (const [name, size] of iconset) writeFileSync(path.join(set, name), png(size));
  writeFileSync(path.join(out, 'AppIcon.icns'), appIconIcns());
  writeFileSync(path.join(out, 'AppIcon.svg'), appIconSvg());
  console.log(JSON.stringify({ iconset: set, icns: path.join(out, 'AppIcon.icns') }));
}
