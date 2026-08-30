/**
 * 見た目 — 色と間合いを、コードではなくデータで持つ。
 *
 * 配置と同じ考え方。ただし分けて持つ。
 * 「配置はそのままで色だけ変えたい」が、気分としては一番多いから。
 *
 * 一日中この画面を見ることになる。
 * 派手さより、長く見ていて疲れないことを既定に置く。
 * 派手なものが欲しい日のために、切り替えられるようにしておく。
 *
 * 値は CSS へそのまま流し込むので、**受け取った文字列は必ず検める**。
 * ここを素通りさせると、色の設定という顔をして何でも書けてしまう。
 */

/** 差し替えられる値。ここに無い名前は受け取らない。 */
export const TOKENS = [
  'bg',        // 一番下の地
  'surface',   // 枠の地
  'surface2',  // 枠の中の一段沈んだ地
  'line',      // 境目
  'text',      // 文字
  'dim',       // 控えめな文字
  'accent',    // 目を引かせたいところ
  'accentText',// accent の上に載る文字
  'good', 'warn', 'bad',
  'radius',    // 角の丸み
  'gap',       // 枠どうしの間
  'shadow',    // 浮き
  'font', 'fontMono', 'fontSize', 'lineHeight',
] as const;

export type TokenName = typeof TOKENS[number];
export type Tokens = Partial<Record<TokenName, string>>;

export interface Theme {
  id: string;
  name: string;
  /** 明暗。ブラウザの標準部品（入力欄や巻物）の色に効く。 */
  scheme: 'dark' | 'light';
  tokens: Tokens;
}

const SANS = "'Inter', ui-sans-serif, system-ui, 'Hiragino Sans', 'Noto Sans JP', sans-serif";
const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, 'Noto Sans Mono', monospace";

/**
 * 用意しておく見た目。
 *
 * 既定は slate。作業中ずっと見ていられることだけを狙っている。
 * 地は真っ黒にしない。真っ黒は文字との差が強すぎて、長時間で目が疲れる。
 * 文字も真っ白にしない。同じ理由。
 */
export const THEMES: Theme[] = [
  {
    id: 'slate',
    name: 'Slate — 落ち着いた暗色（既定）',
    scheme: 'dark',
    tokens: {
      bg: '#0f1116', surface: '#161922', surface2: '#1c2029', line: '#262b36',
      text: '#dfe3ec', dim: '#8e97a8', accent: '#7aa2f7', accentText: '#0b0e14',
      good: '#9ece6a', warn: '#e0af68', bad: '#f7768e',
      radius: '10px', gap: '10px', shadow: '0 1px 2px rgba(0,0,0,.35)',
      font: SANS, fontMono: MONO, fontSize: '14px', lineHeight: '1.55',
    },
  },
  {
    id: 'paper',
    name: 'Paper — 明るい昼向け',
    scheme: 'light',
    tokens: {
      bg: '#f3f4f7', surface: '#ffffff', surface2: '#f7f8fa', line: '#e2e5ec',
      text: '#1c2027', dim: '#69707e', accent: '#3b6fd4', accentText: '#ffffff',
      good: '#2e7d4f', warn: '#a86b12', bad: '#c0384a',
      radius: '10px', gap: '10px', shadow: '0 1px 2px rgba(16,24,40,.06)',
      font: SANS, fontMono: MONO, fontSize: '14px', lineHeight: '1.55',
    },
  },
  {
    id: 'dusk',
    name: 'Dusk — 暖色寄りの夜向け',
    scheme: 'dark',
    tokens: {
      bg: '#14110f', surface: '#1b1815', surface2: '#221e1a', line: '#302a24',
      text: '#e8ddd0', dim: '#a2937f', accent: '#e0a15c', accentText: '#1a1512',
      good: '#a3b565', warn: '#d9a441', bad: '#e07a5f',
      radius: '10px', gap: '10px', shadow: '0 1px 2px rgba(0,0,0,.4)',
      font: SANS, fontMono: MONO, fontSize: '14px', lineHeight: '1.6',
    },
  },
  {
    id: 'cyber',
    name: 'Cyber — 光る夜',
    scheme: 'dark',
    tokens: {
      bg: '#04070e', surface: '#080e1a', surface2: '#0c1524', line: '#123049',
      text: '#d5f2ff', dim: '#5f8ba6', accent: '#22d3ee', accentText: '#02131a',
      good: '#34d399', warn: '#fbbf24', bad: '#fb7185',
      radius: '4px', gap: '8px', shadow: '0 0 0 1px rgba(34,211,238,.12), 0 0 18px rgba(34,211,238,.07)',
      font: SANS, fontMono: MONO, fontSize: '13px', lineHeight: '1.5',
    },
  },
];

export const DEFAULT_THEME_ID = 'slate';

export function baseTheme(id: string): Theme {
  return structuredClone(
    THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID)!);
}

/**
 * 値の検め。
 *
 * 色・長さ・書体・影として意味のある形だけを通す。
 * `}` や `;` や `url(` を含むものは、色の設定ではないので通さない。
 * 弾いたことは黙らない。黙って消すと、なぜ効かないのか分からなくなる。
 */
const FORBIDDEN = /[;{}<>\\]|url\s*\(|@import|expression\s*\(|javascript:/i;

export function isSafeValue(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  if (FORBIDDEN.test(value)) return false;
  // 関数は形の分かっているものだけ
  const calls = value.match(/[a-z-]+\s*\(/gi) ?? [];
  const allowed = new Set([
    'rgb', 'rgba', 'hsl', 'hsla', 'oklch', 'oklab', 'lab', 'lch',
    'color-mix', 'var', 'calc', 'clamp', 'min', 'max',
  ]);
  return calls.every((c) => allowed.has(c.replace(/\s*\($/, '').toLowerCase()));
}

export interface ThemeRepair { detail: string }

/**
 * 読めない見た目を、表示できる見た目に直す。
 * 配置と同じで、ここでも例外は投げないし、空も返さない。
 */
export function repairTheme(raw: unknown, fallbackId = DEFAULT_THEME_ID): {
  theme: Theme; repairs: ThemeRepair[];
} {
  const repairs: ThemeRepair[] = [];
  const note = (detail: string) => repairs.push({ detail });

  if (typeof raw !== 'object' || raw === null) {
    note('見た目を読めなかったので、既定に戻しました。');
    return { theme: baseTheme(fallbackId), repairs };
  }
  const o = raw as Record<string, unknown>;

  // どれを土台にするか。土台があるので、一部だけ差し替えれば済む。
  const baseId = typeof o.base === 'string' ? o.base
    : typeof o.id === 'string' ? o.id : fallbackId;
  const known = THEMES.some((t) => t.id === baseId);
  if (!known && (o.base !== undefined || o.id !== undefined)) {
    note(`知らない見た目 ${String(o.base ?? o.id)} だったので、${fallbackId} を土台にしました。`);
  }
  const base = baseTheme(known ? baseId : fallbackId);

  const tokens: Tokens = { ...base.tokens };
  const given = typeof o.tokens === 'object' && o.tokens !== null
    ? o.tokens as Record<string, unknown> : {};

  for (const [key, value] of Object.entries(given)) {
    if (!TOKENS.includes(key as TokenName)) {
      note(`${key} という項目は無いので無視しました。`);
      continue;
    }
    if (typeof value !== 'string') {
      note(`${key} は文字で書いてください。今の値のままにします。`);
      continue;
    }
    const v = value.trim();
    if (!isSafeValue(v)) {
      note(`${key} の値は受け取れません（色や長さとして読めない書き方です）。`);
      continue;
    }
    tokens[key as TokenName] = v;
  }

  const scheme = o.scheme === 'light' || o.scheme === 'dark' ? o.scheme : base.scheme;

  return {
    theme: {
      id: typeof o.id === 'string' && o.id.trim() ? o.id.trim() : base.id,
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : base.name,
      scheme,
      tokens,
    },
    repairs,
  };
}

/** CSS の変数名に直す。camelCase は繋ぎ字にする。 */
export function cssVarName(token: string): string {
  return '--' + token.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** 画面へ流し込む形。 */
export function toCssVars(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme.tokens)) {
    if (typeof v === 'string' && isSafeValue(v)) out[cssVarName(k)] = v;
  }
  return out;
}
