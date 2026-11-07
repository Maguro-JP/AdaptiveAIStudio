/**
 * アプリの絵柄（installer/AdaptiveAIStudio.ico と src/ui/web/icon.svg）を作る。
 *
 * 絵柄は、黒い角丸の四角に、中の点（白）と周りの 3 つの点（赤・橙）を線で結んだ図。
 * ネットワークモデル（中のモデルが周りの知識とつながる）を表す。
 * 依存は持たない。PNG は zlib で自分で組み、ICO に 16・32・48・256 を入れる。
 * 同じ入力からは毎回同じバイト列が出る（乱数を使わない）。
 *
 * 使い方: node scripts/make-icon.mjs
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 256 を 1 とした座標。SVG と同じ値を使い、画面と setup.exe の絵柄をそろえる
const BG = [17, 17, 17];
const LINE = [120, 120, 120];
const center = { x: 0.5, y: 0.53, r: 0.11, c: [255, 255, 255] };
const outer = [
  { x: 0.5, y: 0.2, r: 0.085, c: [255, 122, 0] },
  { x: 0.22, y: 0.72, r: 0.085, c: [230, 30, 40] },
  { x: 0.78, y: 0.72, r: 0.085, c: [255, 122, 0] },
];
const RADIUS = 0.2;
const WIDTH = 0.035;

function segDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function insideRoundRect(x, y) {
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - RADIUS), 0);
  const qy = Math.max(Math.abs(y - 0.5) - (0.5 - RADIUS), 0);
  return Math.hypot(qx, qy) <= RADIUS;
}

/** 1 点の色（透明なら undefined）。 */
function colorAt(x, y) {
  if (!insideRoundRect(x, y)) return undefined;
  for (const n of [center, ...outer]) if (Math.hypot(x - n.x, y - n.y) <= n.r) return n.c;
  const edges = [...outer.map((o) => [center, o]), [outer[0], outer[1]], [outer[1], outer[2]], [outer[2], outer[0]]];
  for (const [a, b] of edges) if (segDist(x, y, a, b) <= WIDTH / 2) return LINE;
  return BG;
}

/** size×size の RGBA。4×4 の小区画で平均を取り、縁をなめらかにする。 */
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let v = 0; v < S; v++) {
        for (let u = 0; u < S; u++) {
          const c = colorAt((i + (u + 0.5) / S) / size, (j + (v + 0.5) / S) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const o = (j * size + i) * 4;
      if (a) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); }
      px[o + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  return px;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function png(size) {
  const rgba = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let j = 0; j < size; j++) rgba.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bit、RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function ico(sizes) {
  const images = sizes.map(png);
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map((s, k) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[k].length, 8); e.writeUInt32LE(offset, 12);
    offset += images[k].length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...images]);
}

export function svg() {
  const p = (v) => Math.round(v * 256);
  const rgb = (c) => `rgb(${c.join(',')})`;
  const lines = [...outer.map((o) => [center, o]), [outer[0], outer[1]], [outer[1], outer[2]], [outer[2], outer[0]]]
    .map(([a, b]) => `<line x1="${p(a.x)}" y1="${p(a.y)}" x2="${p(b.x)}" y2="${p(b.y)}"/>`).join('');
  const dots = [center, ...outer].map((n) => `<circle cx="${p(n.x)}" cy="${p(n.y)}" r="${p(n.r)}" fill="${rgb(n.c)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="${p(RADIUS)}" fill="${rgb(BG)}"/>`
    + `<g stroke="${rgb(LINE)}" stroke-width="${p(WIDTH)}">${lines}</g>${dots}</svg>\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(root, 'installer', 'AdaptiveAIStudio.ico'), ico([16, 32, 48, 256]));
  writeFileSync(join(root, 'src', 'ui', 'web', 'icon.svg'), svg());
  console.log('installer/AdaptiveAIStudio.ico と src/ui/web/icon.svg を書きました');
}
