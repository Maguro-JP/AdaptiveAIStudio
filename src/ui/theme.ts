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

/**
 * 効果。色と寸法だけでは、見た目の性格までは変えられない。
 *
 * **任意の CSS を流し込ませない。**こちらが用意したものから選ばせる。
 * 流し込みを許すと、見た目の設定が画面を書き換える口になる。
 * 名前で選ばせるなら、書けるのは「どれを使うか」だけになる。
 */
export const EFFECTS = [
  'glass',      // すりガラス。奥が透ける
  'glow',       // 縁が光る
  'scanlines',  // 走査線。古い画面
  'grid',       // 地に方眼
  'noise',      // ざらつき。のっぺりを消す
  'sharp',      // 角を落とさない
  'depth',      // 影を強くして、板が浮いて見える
  'mono',       // 全部を等幅にする
] as const;

export type EffectName = typeof EFFECTS[number];

export interface Theme {
  id: string;
  name: string;
  /** 明暗。ブラウザの標準部品（入力欄や巻物）の色に効く。 */
  scheme: 'dark' | 'light';
  tokens: Tokens;
  /** 重ねる効果。名前で選ぶ。CSS そのものは書かせない。 */
  effects?: EffectName[];
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
    effects: ['glow', 'grid', 'sharp'],
  },
  {
    id: 'neon',
    name: 'Neon — 夜の街',
    scheme: 'dark',
    tokens: {
      bg: '#0a0612', surface: '#120a1f', surface2: '#1a0f2b', line: '#33205c',
      text: '#f0e6ff', dim: '#9b7fc4', accent: '#f472b6', accentText: '#1a0512',
      good: '#4ade80', warn: '#fcd34d', bad: '#f87171',
      radius: '10px', gap: '10px',
      shadow: '0 0 0 1px rgba(244,114,182,.18), 0 8px 32px rgba(168,85,247,.18)',
      font: SANS, fontMono: MONO, fontSize: '13px', lineHeight: '1.55',
    },
    effects: ['glow', 'noise', 'depth'],
  },
  {
    id: 'glass',
    name: 'Glass — すりガラス',
    scheme: 'dark',
    tokens: {
      bg: '#0b1020', surface: 'rgba(148,163,184,.10)', surface2: 'rgba(148,163,184,.16)',
      line: 'rgba(203,213,225,.18)',
      text: '#e8edf7', dim: '#9aa6bd', accent: '#60a5fa', accentText: '#08111f',
      good: '#4ade80', warn: '#fbbf24', bad: '#fb7185',
      radius: '14px', gap: '12px', shadow: '0 8px 40px rgba(2,6,23,.55)',
      font: SANS, fontMono: MONO, fontSize: '13px', lineHeight: '1.6',
    },
    effects: ['glass', 'depth', 'noise'],
  },
  {
    id: 'terminal',
    name: 'Terminal — 古い端末',
    scheme: 'dark',
    tokens: {
      bg: '#0b0f0b', surface: '#0f150f', surface2: '#131a13', line: '#1f2b1f',
      text: '#8fdf8f', dim: '#4f7a4f', accent: '#a3e635', accentText: '#0b0f0b',
      good: '#a3e635', warn: '#facc15', bad: '#f87171',
      radius: '0px', gap: '6px', shadow: 'none',
      font: MONO, fontMono: MONO, fontSize: '13px', lineHeight: '1.45',
    },
    effects: ['scanlines', 'sharp', 'mono', 'glow'],
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

  // 効果は、知っているものだけを通す。知らない名前は捨てて、そう言う。
  const wanted = Array.isArray(o.effects) ? o.effects : base.effects ?? [];
  const effects: EffectName[] = [];
  for (const name of wanted) {
    if (typeof name === 'string' && (EFFECTS as readonly string[]).includes(name)) {
      if (!effects.includes(name as EffectName)) effects.push(name as EffectName);
    } else {
      note(`知らない効果なので外しました: ${String(name)}`);
    }
  }

  return {
    theme: {
      id: typeof o.id === 'string' && o.id.trim() ? o.id.trim() : base.id,
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : base.name,
      scheme,
      tokens,
      ...(effects.length > 0 ? { effects } : {}),
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
