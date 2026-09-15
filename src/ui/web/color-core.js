/**
 * 色を扱う。
 *
 * 色は、書いた文字を見ても分からない。`#7aa2f7` が何色かは、出してみないと分からない。
 * だから**書いてある色を見つけて、その場に見せる**。設定のときだけでなく、
 * コードを読んでいる最中にも要る。むしろそちらの方が要る。
 *
 * ここは論理だけ。画面の部品は `color.js`。
 * **素の JS で書く。**ブラウザからも Node からも同じものを読ませるため。
 * 型は color-core.d.ts で宣言する。二重に持つと、片方だけ直して食い違う。
 */

/** よく書かれる名前だけ。全部は入れない（使わない物が増えるだけ）。 */
export const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', lime: '#00ff00', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', silver: '#c0c0c0', gray: '#808080',
  grey: '#808080', maroon: '#800000', olive: '#808000', green: '#008000', purple: '#800080',
  teal: '#008080', navy: '#000080', orange: '#ffa500', pink: '#ffc0cb', gold: '#ffd700',
  crimson: '#dc143c', indigo: '#4b0082', violet: '#ee82ee', tomato: '#ff6347',
  transparent: '#00000000',
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n) => Math.round(n * 100) / 100;

/**
 * 書かれている色を読む。読めなければ undefined。
 *
 * **推測しない。**読めないものを黒として扱うと、
 * 打ち間違いが黒い色として通ってしまい、間違いに気づけない。
 */
export function parse(input) {
  const text = input.trim().toLowerCase();
  if (text.length === 0) return undefined;

  const named = NAMED[text];
  if (named) return parse(named);

  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const h = hex[1];
    const expand = (s) => parseInt(s.length === 1 ? s + s : s, 16);
    if (h.length === 3 || h.length === 4) {
      return {
        r: expand(h[0]), g: expand(h[1]), b: expand(h[2]),
        a: h.length === 4 ? expand(h[3]) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    return undefined;
  }

  // rgb(…) / rgba(…)。区切りは , でも空白でもよい（どちらも書かれる）。
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter((p) => p.length > 0);
    if (parts.length < 3) return undefined;
    const num = (s, max) => (s.endsWith('%')
      ? (parseFloat(s) / 100) * max
      : parseFloat(s));
    const [r, g, b] = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255)];
    if ([r, g, b].some((n) => Number.isNaN(n))) return undefined;
    const a = parts[3] === undefined ? 1 : num(parts[3], 1);
    return { r: clamp(Math.round(r), 0, 255), g: clamp(Math.round(g), 0, 255), b: clamp(Math.round(b), 0, 255), a: clamp(a, 0, 1) };
  }

  const hsl = /^hsla?\(([^)]+)\)$/.exec(text);
  if (hsl) {
    const parts = hsl[1].split(/[,/\s]+/).filter((p) => p.length > 0);
    if (parts.length < 3) return undefined;
    const h = parseFloat(parts[0]);
    const s = parseFloat(parts[1]) / 100;
    const l = parseFloat(parts[2]) / 100;
    if ([h, s, l].some((n) => Number.isNaN(n))) return undefined;
    const a = parts[3] === undefined ? 1 : (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]));
    return hslToRgb({ h: ((h % 360) + 360) % 360, s: clamp(s, 0, 1), l: clamp(l, 0, 1), a: clamp(a, 0, 1) });
  }

  return undefined;
}

export function hslToRgb({ h, s, l, a }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return {
    r: Math.round((r1 + m) * 255), g: Math.round((g1 + m) * 255), b: Math.round((b1 + m) * 255), a,
  };
}

export function rgbToHsl({ r, g, b, a }) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (d !== 0) {
    h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  // **ここで丸めない。**丸めるのは見せるときだけ。
  // 内側で丸めると、つまみを動かすたびに色がずれていく。
  return { h, s, l, a };
}

export function toHex({ r, g, b, a }) {
  const two = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  // 透けていないなら 8桁にしない。読む側にとって余計な情報になる。
  return `#${two(r)}${two(g)}${two(b)}${a < 1 ? two(a * 255) : ''}`;
}

export function toRgbString({ r, g, b, a }) {
  return a < 1 ? `rgba(${r}, ${g}, ${b}, ${round(a)})` : `rgb(${r}, ${g}, ${b})`;
}

export function toHslString(rgb) {
  const { h, s, l, a } = rgbToHsl(rgb);
  const p = (n) => `${Math.round(n * 100)}%`;
  return a < 1
    ? `hsla(${Math.round(h)}, ${p(s)}, ${p(l)}, ${round(a)})`
    : `hsl(${Math.round(h)}, ${p(s)}, ${p(l)})`;
}

/**
 * 書かれている色を、文の中から見つける。
 *
 * コードを読んでいる最中に効かせたいので、**位置も返す**。
 * 位置が無いと、見つけた色を元の場所に重ねられない。
 */
const PATTERN = new RegExp(
  [
    '#[0-9a-fA-F]{3,8}\\b',
    'rgba?\\([^)]*\\)',
    'hsla?\\([^)]*\\)',
    `\\b(?:${Object.keys(NAMED).join('|')})\\b`,
  ].join('|'),
  'g',
);

export function findColors(text, limit = 200) {
  const out = [];
  for (const m of text.matchAll(PATTERN)) {
    if (out.length >= limit) break;
    const rgb = parse(m[0]);
    // 読めなかったものは色として扱わない。#deadbeef のような
    // 「色に見えるが色ではない」文字列を拾わないため。
    if (!rgb) continue;
    out.push({ value: m[0], start: m.index, end: m.index + m[0].length, rgb });
  }
  return out;
}

/**
 * 明るさの比。文字と地の組み合わせが読めるかどうか。
 *
 * 色を選べるようにすると、**選べてしまう**。
 * 読めない組み合わせを選んだときに、それが分かる方がよい。
 */
export function contrast(a, b) {
  const lum = ({ r, g, b: bl }) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return round((l1 + 0.05) / (l2 + 0.05));
}

/** 読みやすさの目安。数字だけ出しても判断できないので、言葉にする。 */
export function readability(ratio) {
  if (ratio >= 7) return { level: 'good', label: `${ratio}:1 よく読める` };
  if (ratio >= 4.5) return { level: 'good', label: `${ratio}:1 読める` };
  if (ratio >= 3) return { level: 'warn', label: `${ratio}:1 大きな字なら読める` };
  return { level: 'bad', label: `${ratio}:1 読みにくい` };
}
