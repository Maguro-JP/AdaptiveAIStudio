/**
 * 語のプールと文の型と、外の世界の仕組みの文を読む（IDEAMAN の ideaman/data の 3 本を JSON に直して同梱したもの）。
 *
 * 起動してから 1 度だけ読み、以後は同じものを使う。実行時の依存は無い（YAML を読む部品を持たないので JSON にした）。
 * 仕組みの文は日本語版ウィキペディアの記事の文で、CC BY-SA 4.0。出典の URL を 1 件ずつ持つ（data/NOTICE.md）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = join(import.meta.dirname, 'data');

/** 引く対象のプール。型の needs の名前とは `SLOT_TO_POOL` で結ぶ。 */
export const POOL_NAMES = ['concepts', 'operations', 'constraints', 'provocations', 'aspects', 'probes'] as const;
export type PoolName = typeof POOL_NAMES[number] | 'mechanisms' | 'materials';

export interface Term {
  term: string;
  domains: readonly string[];
  /**
   * 語の形。`aspects` では `noun`（名詞句。既定）か `clause`（疑問節。「誰が決めるか」）。
   * `operations` では `verb`（「{側面}を{操作}」に入る）か `phrase`（自分の目的語を持つ）。
   * 形を分けないと「連鎖の誰が決めるかを取り除く」のような壊れた文が出る。
   */
  kind: string;
  /** `mechanisms` だけ。何をどうしているかの 1 文と、その出典と、どの側面の話か。 */
  how?: string;
  source?: string;
  aspect?: string;
}

export interface Template {
  id: string;
  /** `proposal`（明日試せる具体策）か `question`（見方を変える問い）。 */
  tone: string;
  needs: readonly string[];
  text: string;
}

export interface Lexicon {
  pools: Record<string, readonly Term[]>;
  moods: readonly string[];
  templates: readonly Template[];
  /** 仕組みの文の数（側面が付いていて引かれるものと、ファイルに在る全部）。 */
  mechanismsTotal: number;
  /** 仕組みの文のライセンスの表示。 */
  mechanismsLicense: { name: string; url: string; attribution: string };
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8').replace(/^﻿/, ''));
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** JSON から読む。プールか型が空なら投げる（空のまま札を出そうとして、分からない落ち方をしないように）。 */
export function loadLexicon(dir: string = DATA_DIR): Lexicon {
  const read = (name: string): Record<string, unknown> => {
    const raw = dir === DATA_DIR ? readJson(name) : JSON.parse(readFileSync(join(dir, name), 'utf8'));
    return (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  };
  const lex = read('lexicon.json');
  const rawPools = (lex.pools && typeof lex.pools === 'object' ? lex.pools : {}) as Record<string, unknown>;
  const pools: Record<string, readonly Term[]> = {};
  for (const name of POOL_NAMES) {
    const items = Array.isArray(rawPools[name]) ? rawPools[name] as Array<Record<string, unknown>> : [];
    pools[name] = items.filter((it) => typeof it?.term === 'string').map((it) => ({
      term: it.term as string, domains: strings(it.domains), kind: typeof it.kind === 'string' ? it.kind : 'noun',
    }));
    if (pools[name]!.length === 0) throw new Error(`語のプール ${name} が空です: ${join(dir, 'lexicon.json')}`);
  }
  const mech = read('mechanisms.json');
  const all = Array.isArray(mech.mechanisms) ? mech.mechanisms as Array<Record<string, unknown>> : [];
  // 側面の付いていない 1 文は引かない（物の構造の話は、ほかの題材に移しにくく、的も名指しできない）。ファイルには残す
  pools.mechanisms = all
    .filter((it) => typeof it?.subject === 'string' && typeof it.how === 'string' && typeof it.aspect === 'string' && it.aspect)
    .map((it) => ({
      term: it.subject as string, domains: strings(it.domains), kind: 'noun',
      how: String(it.how).trim().replace(/。$/, ''), source: typeof it.source === 'string' ? it.source : '', aspect: it.aspect as string,
    }));
  const tpl = read('templates.json');
  const templates = (Array.isArray(tpl.templates) ? tpl.templates as Array<Record<string, unknown>> : [])
    .filter((it) => typeof it?.id === 'string' && typeof it.text === 'string')
    .map((it) => ({ id: it.id as string, tone: String(it.tone ?? 'proposal'), needs: strings(it.needs), text: it.text as string }));
  if (templates.length === 0) throw new Error(`文の型が空です: ${join(dir, 'templates.json')}`);
  const moods = strings(lex.moods);
  return {
    pools, moods: moods.length > 0 ? moods : ['静穏'], templates, mechanismsTotal: all.length,
    mechanismsLicense: {
      name: typeof mech.license === 'string' ? mech.license : 'CC BY-SA 4.0',
      url: typeof mech.licenseUrl === 'string' ? mech.licenseUrl : 'https://creativecommons.org/licenses/by-sa/4.0/deed.ja',
      attribution: typeof mech.attribution === 'string' ? mech.attribution : '',
    },
  };
}

let cached: Lexicon | undefined;
/** 同梱の語と型。1 度だけ読む。 */
export function defaultLexicon(): Lexicon {
  cached ??= loadLexicon();
  return cached;
}

/** 同梱のデータの数（doctor と設定の画面に出す）。 */
export function lexiconCounts(lex: Lexicon = defaultLexicon()): { terms: number; templates: number; mechanisms: number; mechanismsTotal: number } {
  return {
    terms: POOL_NAMES.reduce((n, name) => n + lex.pools[name]!.length, 0),
    templates: lex.templates.length,
    mechanisms: lex.pools.mechanisms!.length,
    mechanismsTotal: lex.mechanismsTotal,
  };
}
