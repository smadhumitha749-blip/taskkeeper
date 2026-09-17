// Generates the PNG app icons for the PWA (manifest + iOS home screen).
// Pure Node — built-in modules only (zlib). Run: npm run make-icons
// Outputs to: ../frontend/icons/icon-192.png, icon-512.png, apple-touch-icon.png

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "frontend", "icons");

/* ---------- minimal PNG encoder (RGBA, bit depth 8, filter 0) ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[p++] = rgba[i];
      raw[p++] = rgba[i + 1];
      raw[p++] = rgba[i + 2];
      raw[p++] = rgba[i + 3];
    }
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- drawing (normalized coords in [0,1], supersampled AA) ---------- */

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

const TEAL_TOP = [0x1e, 0x51, 0x4a];
const TEAL_BOTTOM = [0x33, 0x70, 0x66];
const AMBER = [0xc9, 0x8a, 0x3a];
const PAPER = [0xf8, 0xfa, 0xf7];

function sample(nx, ny) {
  if (!inRoundRect(nx, ny, 0, 0, 1, 1, 0.22)) return [0, 0, 0, 0];

  let col = [lerp(TEAL_TOP[0], TEAL_BOTTOM[0], ny), lerp(TEAL_TOP[1], TEAL_BOTTOM[1], ny), lerp(TEAL_TOP[2], TEAL_BOTTOM[2], ny), 255];

  if (inCircle(nx, ny, 0.5, 0.5, 0.28)) col = [AMBER[0], AMBER[1], AMBER[2], 255];

  // White clock hands + center hub (stay inside the safe zone for maskable icons).
  if (inRect(nx, ny, 0.5 - 0.045, 0.5 - 0.045, 0.5 + 0.045, 0.235)) col = [PAPER[0], PAPER[1], PAPER[2], 255];
  if (inRect(nx, ny, 0.5, 0.5 - 0.045, 0.765, 0.5 + 0.045)) col = [PAPER[0], PAPER[1], PAPER[2], 255];
  if (inCircle(nx, ny, 0.5, 0.5, 0.085)) col = [PAPER[0], PAPER[1], PAPER[2], 255];

  return col;
}

function render(size) {
  const SS = 4; // 4x4 supersampling
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (x + (sx + 0.5) / SS) / size;
          const ny = (y + (sy + 0.5) / SS) / size;
          const c = sample(nx, ny);
          r += c[0];
          g += c[1];
          b += c[2];
          a += c[3];
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  { name: "apple-touch-icon.png", size: 180 },
];
for (const t of targets) {
  const file = path.join(OUT_DIR, t.name);
  fs.writeFileSync(file, render(t.size));
  console.log(`wrote ${file} (${t.size}x${t.size})`);
}