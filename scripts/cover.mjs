// Generates cover.png (800x534) for gladys-openepaperlink: plain Node, no dependency.
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};

// Background: diagonal gradient, night blue to violet.
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [20 + 60 * t, 24 + 20 * t, 70 + 70 * t]);
  }
}
const white = [255, 255, 255];
const accent = [255, 176, 59];

const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
// Rounded rectangle, anti-aliased corners.
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const arc = (cx, cy, r, width, from, to, color) => {
  for (let y = Math.floor(cy - r - width); y <= cy + r + width; y += 1) {
    for (let x = Math.floor(cx - r - width); x <= cx + r + width; x += 1) {
      const ang = Math.atan2(y - cy, x - cx);
      if (ang < from || ang > to) continue;
      const a = Math.max(
        0,
        Math.min(1, width / 2 - Math.abs(Math.hypot(x - cx, y - cy) - r) + 0.5),
      );
      if (a > 0) set(x, y, color, a);
    }
  }
};

// Soft halo.
disc(400, 267, 250, white, 0.05);
disc(400, 267, 190, white, 0.05);
const ink = [24, 24, 28];
const red = [214, 40, 40];
const paper = [236, 234, 226];
// The access point: a box with its antenna and the radio waves toward the tags.
box(90, 300, 230, 400, 16, [40, 44, 58]);
box(98, 308, 222, 392, 12, [58, 63, 80]);
disc(130, 350, 8, [90, 220, 120]);
box(200, 230, 210, 304, 4, [40, 44, 58]);
for (const r of [36, 62, 88]) {
  arc(205, 230, r, 8, -Math.PI * 0.75, -Math.PI * 0.05, accent);
}
// The big tag: a white frame, the e-paper with "text" lines and a red line.
box(300, 120, 720, 420, 26, [250, 250, 250]);
box(318, 138, 702, 402, 14, paper);
const bar = (x, y, w, h, color) => box(x, y, x + w, y + h, 6, color);
bar(350, 175, 300, 34, ink);
bar(350, 235, 220, 22, ink);
bar(350, 275, 260, 22, ink);
bar(350, 330, 180, 30, red);
// A small tag in front.
box(560, 300, 760, 450, 18, [250, 250, 250]);
box(572, 312, 748, 438, 10, paper);
bar(595, 340, 90, 20, ink);
bar(595, 375, 90, 14, ink);
bar(595, 402, 110, 14, red);
// Battery and temperature hints on the small tag.
box(700, 340, 730, 356, 3, ink);
box(730, 344, 734, 352, 1, ink);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
