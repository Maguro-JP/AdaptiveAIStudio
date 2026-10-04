/**
 * 自発性 — 依頼を待たずに、自分で調べて提案する。
 *
 * 「LLMを動かす場所」と「AIが動く場所」の違いはここにある。
 * 待機中に何もしないなら、それはただの実行環境でしかない。
 *
 * 流れ:
 *   手がかりを探す → 一つ選んで調べる → 提案としてまとめる → 承認待ちに積む
 *
 * 手がかりは推測ではなく、確認できる事実から拾う。
 * 「なんとなく改善できそう」は雑音になるので出さない。
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectSnapshot } from './prefetch.ts';
import { snapshotTests } from './test-integrity.ts';
import type { ProposalKind } from './proposals.ts';

export interface Lead {
  kind: ProposalKind;
  /** 何に気づいたか */
  title: string;
  /** 調べるべきファイル */
  files: string[];
  /** 事実として確認できたこと */
  fact: string;
  /** 同じ手がかりを繰り返さないための指紋 */
  fingerprint: string;
  /** 優先度。高いものから調べる。 */
  weight: number;
}

export interface LeadOptions {
  root: string;
  snapshot: ProjectSnapshot;
  /** 既に提案済みの指紋。重複を避ける。 */
  known: Set<string>;
  max?: number;
}

/**
 * 手がかりを集める。ここではモデルを使わない。
 * 事実の収集は機械の方が速く、確実で、無料。
 */
export async function findLeads(opts: LeadOptions): Promise<Lead[]> {
  const { root, snapshot, known } = opts;
  const leads: Lead[] = [];

  /**
   * ファイルの状態を指紋に混ぜる。
   * 中身が変われば別の手がかりとして扱われ、変わらなければ調べ直さない。
   */
  const signatureOf = async (file: string): Promise<string> => {
    const info = await stat(join(root, file)).catch(() => undefined);
    return info ? `${info.size}:${Math.round(info.mtimeMs)}` : '0';
  };

  const tests = await snapshotTests(root).catch(() => undefined);
  // 読めなかったテストファイルも「在る」側に数える（中身が読めないだけで、無いのではない）
  const testedBasenames = new Set(
    [...(tests?.files.keys() ?? []), ...[...(tests?.unreadable ?? [])].filter((f) => !f.endsWith('/'))]
      .map((f) => baseName(f).replace(/[._](test|spec)$/, '').replace(/^test_/, '')),
  );
  // 数え直しそのものが落ちた・中を見られないフォルダがある: どのテストが在るか分からない。「見当たりません」と言わない
  // （言うと、在るテストの二つ目を書かせにいく）
  const testsKnown = tests !== undefined && ![...(tests.unreadable ?? [])].some((f) => f.endsWith('/'));

  // 未コミットの変更。作業中のものが一番関心が高い。
  if (snapshot.git?.kind === 'dirty') {
    for (const entry of snapshot.git.changed.slice(0, 5)) {
      const path = entry.trim();
      leads.push(lead({
        kind: 'question',
        title: `未コミットの変更: ${path}`,
        files: [path],
        fact: '作業ディレクトリに未コミットの変更があります。',
        weight: 3,
      }, await signatureOf(path)));
    }
  }

  for (const file of snapshot.files) {
    if (!isSource(file)) continue;

    // 検査されていない実装。これは事実として確認できる。
    if (testsKnown && !isTestPath(file) && !testedBasenames.has(baseName(file))) {
      leads.push(lead({
        kind: 'test',
        title: `${file} に対応するテストが見当たりません`,
        files: [file],
        fact: 'ファイル名から対応するテストファイルを見つけられませんでした。',
        weight: 5,
      }, await signatureOf(file)));
    }

    const abs = join(root, file);
    const info = await stat(abs).catch(() => undefined);
    if (!info || info.size > 400_000) continue;
    const text = await readFile(abs, 'utf8').catch(() => undefined);
    if (text === undefined) continue;

    // 残された印。書いた本人が「後で」と思ったところ。
    const marks = text.match(/\b(TODO|FIXME|XXX|HACK)\b[^\n]{0,120}/g);
    if (marks && marks.length > 0) {
      leads.push(lead({
        kind: 'risk',
        title: `${file} に未処理の印が ${marks.length} 件`,
        files: [file],
        fact: marks.slice(0, 3).map((m) => m.trim()).join(' / '),
        weight: 4,
      }, `${info.size}:${Math.round(info.mtimeMs)}`));
    }

    // 握り潰された例外。原因が見えなくなる典型。
    const swallowed = text.match(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g);
    if (swallowed && swallowed.length > 0) {
      leads.push(lead({
        kind: 'bug',
        title: `${file} に中身が空の catch が ${swallowed.length} 件`,
        files: [file],
        fact: '例外を握り潰しているため、失敗しても表に出ません。',
        weight: 6,
      }, `${info.size}:${Math.round(info.mtimeMs)}`));
    }

    // 大きすぎるファイル。読めない＝直せない。
    const lines = text.split('\n').length;
    if (lines > 600) {
      leads.push(lead({
        kind: 'cleanup',
        title: `${file} が ${lines} 行あります`,
        files: [file],
        fact: '1ファイルとして大きく、変更の影響範囲が読みにくくなっています。',
        weight: 2,
      }, `${info.size}:${Math.round(info.mtimeMs)}`));
    }
  }

  return leads
    .filter((l) => !known.has(l.fingerprint))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, opts.max ?? 5);
}

function lead(l: Omit<Lead, 'fingerprint'>, signature: string): Lead {
  return {
    ...l,
    fingerprint: createHash('sha1')
      .update(`${l.kind}::${l.title}::${signature}`)
      .digest('hex')
      .slice(0, 12),
  };
}

/** 手がかりをモデルへ渡す依頼文。調べさせて、提案にまとめさせる。 */
export function investigationPrompt(lead: Lead): string {
  return [
    '以下は自動で見つけた手がかりです。裏を取って、提案としてまとめてください。',
    '',
    `気づいたこと: ${lead.title}`,
    `確認できた事実: ${lead.fact}`,
    `対象: ${lead.files.join(', ')}`,
    '',
    '手順:',
    '1. read_file / search_text で該当箇所を実際に確認する',
    '2. 本当に問題か判断する。問題でなければ「問題なし」と答える',
    '3. 問題なら、以下の形式だけを出力する（前置きも後書きも不要）',
    '',
    'PROPOSAL',
    'title: 一行の要約',
    'rationale: なぜ問題か（確認した内容に基づいて）',
    'action: 何をすればよいか（そのまま依頼文として使える形で）',
    '',
    '重要: ファイルを変更してはいけません。調べて提案するだけです。',
    '確認せずに推測で書かないでください。問題が無いなら「問題なし」と答えてください。',
  ].join('\n');
}

/** モデルの出力から提案を取り出す。形式に従っていなければ採用しない。 */
/**
 * 見回り（recon）が調べ切らずに終わったか（理由を返す）。落ちた・止められた・空の回は、呼ぶ側が先に見ている。
 *
 * ターンの上限で終わった回は、調べ切っていない。手が止まった回（`noProgress`）でも、PROPOSAL を言い終えていれば採る
 * （小さいモデルは終わりの合図を書かずに止まりがち。合議 `panel.ts` と同じ扱い）。出力の上限で切れた回の PROPOSAL は、
 * 途中までなので採らない。
 */
export function reconCutShort(finishedWith: string | undefined, detail: string | undefined, text: string): string | undefined {
  if (finishedWith === undefined || finishedWith === 'completed') return undefined;
  if (finishedWith === 'maxTurns') return '調べ切れませんでした（ターンの上限）';
  const cut = /上限で切れ/.test(detail ?? '');
  if (!cut && parseProposal(text) !== undefined) return undefined;
  return cut ? '調べ切れませんでした（出力の上限で切れました）' : '調べ切れませんでした（途中で止まりました）';
}

export function parseProposal(text: string): {
  title: string; rationale: string; action: string;
} | undefined {
  if (!/PROPOSAL/.test(text)) return undefined;
  const body = text.slice(text.indexOf('PROPOSAL') + 'PROPOSAL'.length);
  const pick = (key: string): string | undefined => {
    const m = new RegExp(`^\\s*${key}\\s*[:：]\\s*(.+?)\\s*$`, 'mi').exec(body);
    return m?.[1]?.trim();
  };
  const title = pick('title');
  const rationale = pick('rationale');
  const action = pick('action');
  if (!title || !action) return undefined;
  return { title, rationale: rationale ?? '（理由の記載なし）', action };
}

function isSource(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs)$/.test(path);
}

function isTestPath(path: string): boolean {
  return /(\.|_|^)(test|spec)\.|(^|\/)tests?\//i.test(path);
}

function baseName(path: string): string {
  return path.split('/').pop()!.replace(/\.[^.]+$/, '');
}
