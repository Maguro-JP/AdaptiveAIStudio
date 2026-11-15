import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, qrSvg } from '../src/ui/qr.ts';

/*
 * 組んだ QR を読み戻して確かめる（読む側は QR の決まりから別に書く）。
 * 形式の情報（BCH）を読んで型を知り、型を外し、蛇行で読み、ブロックをほどき、誤り訂正の余りが 0 になること、中身が元の文字であることを見る。
 */
const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
const ECC = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

function readFormat(m: boolean[][]): { level: number; mask: number } {
  let f = 0;
  const b = (x: number, y: number) => (m[y]![x] ? 1 : 0);
  // 左上の写し（ビット 14 から 0 の順）
  const bits = [b(8, 0), b(8, 1), b(8, 2), b(8, 3), b(8, 4), b(8, 5), b(8, 7), b(8, 8), b(7, 8), b(5, 8), b(4, 8), b(3, 8), b(2, 8), b(1, 8), b(0, 8)];
  for (let i = 14; i >= 0; i--) f = (f << 1) | bits[i]!;
  f ^= 0x5412;
  const data = f >>> 10;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  assert.equal(((data << 10) | (rem & 0x3ff)), f, '形式の情報の BCH が合わない');
  return { level: data >>> 3, mask: data & 7 };
}

function isFunction(size: number, ver: number, x: number, y: number): boolean {
  if (x === 6 || y === 6) return true;
  if ((x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8)) return true;
  if (ver >= 7 && ((x >= size - 11 && y < 6) || (y >= size - 11 && x < 6))) return true;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    for (const ax of pos) for (const ay of pos) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === pos[n - 1]) || (ax === pos[n - 1] && ay === 6)) continue;
      if (Math.abs(x - ax) <= 2 && Math.abs(y - ay) <= 2) return true;
    }
  }
  return false;
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}
/** 受けた語の並びを α^0..α^(n-1) で評価して、全部 0 なら誤りなし。 */
function syndromesZero(block: number[], eccLen: number): boolean {
  for (let k = 0; k < eccLen; k++) {
    let a = 1;
    for (let i = 0; i < k; i++) a = gfMul(a, 2);
    let s = 0;
    for (const c of block) s = gfMul(s, a) ^ c;
    if (s !== 0) return false;
  }
  return true;
}

function decode(m: boolean[][]): string {
  const size = m.length;
  const ver = (size - 17) / 4;
  const { level, mask } = readFormat(m);
  assert.equal(level, 0, '誤り訂正は M のはず');
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!isFunction(size, ver, x, y)) bits.push((m[y]![x] !== MASKS[mask]!(x, y)) ? 1 : 0);
      }
    }
  }
  const words: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const nb = BLOCKS[ver]!; const ecc = ECC[ver]!;
  const raw = words.length;
  const numShort = nb - (raw % nb);
  const shortLen = Math.floor(raw / nb);
  const blocks: number[][] = Array.from({ length: nb }, () => []);
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++) {
    for (let j = 0; j < nb; j++) {
      if (i === shortLen - ecc && j < numShort) continue;
      if (k < raw) blocks[j]!.push(words[k++]!);
    }
  }
  const data: number[] = [];
  for (const b of blocks) {
    assert.ok(syndromesZero(b, ecc), '誤り訂正の余りが合わない');
    data.push(...b.slice(0, b.length - ecc));
  }
  const dbits = data.flatMap((w) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (w >>> i) & 1));
  const take = (n: number) => dbits.splice(0, n).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(take(4), 0b0100, 'byte モードのはず');
  const len = take(ver < 10 ? 8 : 16);
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(take(8));
  return new TextDecoder().decode(new Uint8Array(out));
}

test('組んだ QR を読み戻すと元の文字になる（版 1〜10、型 0〜7）', () => {
  const samples = ['A', 'http://192.168.1.5:4174/phone.html#p=abcd-efgh-jkmn-pqrs', 'スマホから使う', 'x'.repeat(100), 'y'.repeat(200)];
  const versions = new Set<number>();
  for (const s of samples) {
    for (let mask = 0; mask < 8; mask++) {
      const m = qrMatrix(s, mask);
      versions.add((m.length - 17) / 4);
      assert.equal(readFormat(m).mask, mask);
      assert.equal(decode(m), s);
    }
    assert.equal(decode(qrMatrix(s)), s);
  }
  assert.ok(versions.has(1) && versions.has(10) && [...versions].some((v) => v >= 7), `試した版: ${[...versions]}`);
});

test('位置の模様が三隅にある', () => {
  const m = qrMatrix('hello');
  const n = m.length;
  for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]] as const) {
    assert.ok(m[y]![x] && m[y + 6]![x + 6] && !m[y + 1]![x + 1] && m[y + 3]![x + 3]);
  }
});

test('入りきらない長さは、切らずに投げる', () => {
  assert.throws(() => qrMatrix('z'.repeat(214)), /入りきりません/);
});

test('SVG は余白付きで、題の文字を逃がす', () => {
  const svg = qrSvg('abc', '<"&>');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29"/);
  assert.ok(!svg.includes('<"&>'));
});

test('読み戻しの見張りが効く（一升だけ変えると合わなくなる）', () => {
  const m = qrMatrix('http://10.0.0.2:4174/phone.html', 2);
  m[m.length - 1]![m.length - 1] = !m[m.length - 1]![m.length - 1];
  assert.throws(() => decode(m));
});
