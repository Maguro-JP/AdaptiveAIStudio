/**
 * 組み込み規則。
 *
 * それぞれ「モデルがやりがちな誤った選択」に対応している。
 * プロンプトで禁じるのではなく、実行の手前で止める。
 */
import { readFile, stat } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';
import { minimatch } from './glob.ts';
import { safeResolve } from '../agent/tools/paths.ts';
import { type Rule, type RuleContext, allow, deny, ok, argString } from './rules.ts';
import type { ToolCall } from '../providers/contract.ts';

/**
 * 作業ディレクトリの外へ出さない。
 * ツール側にも同じ検査があるが、規則としても持つ。
 * ツールを増やすたびに検査を書き直すのは漏れの元なので、境界で一括して見る。
 */
export const workspaceBoundary: Rule = {
  name: 'workspace-boundary',
  description: '作業ディレクトリの外を読み書きさせない',
  pre(call, ctx) {
    const path = argString(call, 'path');
    if (!path) return allow;
    if (safeResolve(ctx.root, path)) return allow;
    return deny(`作業ディレクトリの外です: ${path}。この範囲でのみ作業してください。`);
  },
};

/**
 * 触ってはいけないファイルを守る。
 * 「.env を読んで直す」のような、善意で始まる事故を止める。
 */
export function protectedPaths(patterns: string[], opts: { nocase?: boolean } = {}): Rule {
  return {
    name: 'protected-paths',
    description: `保護対象への書き込みを禁じる: ${patterns.join(', ')}`,
    pre(call, ctx) {
      if (call.name !== 'write_file') return allow;
      const path = argString(call, 'path');
      if (!path) return allow;
      const rel = normalize(ctx.root, path);
      // 大小を区別しない機械では `.ENV` も `.env`。区別すると守りをすり抜ける。
      const hit = patterns.find((p) => minimatch(rel, p, opts));
      return hit ? deny(`${rel} は保護されています（${hit}）。このファイルは変更できません。`) : allow;
    },
  };
}

/**
 * テストの削除・skip を書き込みの時点で止める。
 *
 * 検証ループの後段でも検出しているが、そこでは既に書かれた後になる。
 * 「通すためにテストを消す」は書かせる前に止める方が確実。
 */
export const testProtection: Rule = {
  name: 'test-protection',
  description: 'テストの削除・skip 化を書き込み前に止める',
  async pre(call, ctx) {
    if (call.name !== 'write_file') return allow;
    const path = argString(call, 'path');
    const content = argString(call, 'content');
    if (!path || content === undefined) return allow;
    if (!isTestFile(path)) return allow;

    const abs = safeResolve(ctx.root, path);
    if (!abs) return allow; // 範囲外は別の規則が止める

    const before = await readFile(abs, 'utf8').catch(() => undefined);
    if (before === undefined) return allow; // 新規作成は歓迎

    const was = countCases(before);
    const now = countCases(content);
    if (now < was) {
      return deny(
        `${path} のテストが ${was} 件から ${now} 件に減っています。` +
        'テストを消して通すことはできません。実装side を直してください。',
      );
    }
    const skipsAdded = countSkips(content) - countSkips(before);
    if (skipsAdded > 0) {
      return deny(
        `${path} に skip が ${skipsAdded} 件増えています。` +
        'テストを無効化して通すことはできません。実装側を直してください。',
      );
    }
    return allow;
  },
};

/**
 * 一度の作業で触れるファイル数を制限する。
 *
 * 依頼の範囲を超えて広く書き換え始めたら、それは理解できていない兆候。
 * 止めて、分割させる方が結果的に速い。
 */
export function blastRadius(maxFiles: number): Rule {
  return {
    name: 'blast-radius',
    description: `1つの依頼で書き換えるファイルを ${maxFiles} 件までに制限する`,
    pre(call, ctx) {
      if (call.name !== 'write_file') return allow;
      const path = argString(call, 'path');
      if (!path) return allow;

      const written = new Set(
        ctx.history
          .filter((c) => c.name === 'write_file')
          .map((c) => argString(c, 'path'))
          .filter((p): p is string => !!p),
      );
      if (written.has(path) || written.size < maxFiles) return allow;

      return deny(
        `1つの依頼で書き換えられるのは ${maxFiles} 件までです（既に ${[...written].join(', ')}）。` +
        'ここまでの変更を報告して終え、続きは次の依頼として分けてください。',
      );
    },
  };
}

/**
 * 読まずに書くのを止める。
 *
 * 既存ファイルを read_file / search_text せずに全文で上書きすると、
 * 知らない内容を消す。write_file は全文渡しなので、これは実際に起きる。
 */
export const readBeforeWrite: Rule = {
  name: 'read-before-write',
  description: '既存ファイルを読まずに上書きさせない',
  async pre(call, ctx) {
    if (call.name !== 'write_file') return allow;
    const path = argString(call, 'path');
    if (!path) return allow;

    const abs = safeResolve(ctx.root, path);
    if (!abs) return allow;
    const exists = (await stat(abs).catch(() => undefined)) !== undefined;
    if (!exists) return allow; // 新規作成は読みようがない

    const sawIt = ctx.history.some((c) =>
      (c.name === 'read_file' && argString(c, 'path') === path) ||
      (c.name === 'write_file' && argString(c, 'path') === path) ||
      c.name === 'search_text');
    if (sawIt) return allow;

    return deny(
      `${path} をまだ読んでいません。write_file は全文を置き換えるため、` +
      '先に read_file で現在の内容を確認してください。',
    );
  },
};

/**
 * 同じ書き込みの繰り返しを止める。
 * 直したつもりで同じ内容を書き続けるのは、行き詰まりの典型。
 */
export const noRepeatedWrites: Rule = {
  name: 'no-repeated-writes',
  description: '同一内容の書き込みの繰り返しを止める',
  pre(call, ctx) {
    if (call.name !== 'write_file') return allow;
    const signature = `${argString(call, 'path')}::${argString(call, 'content')}`;
    const repeats = ctx.history.filter((c) =>
      c.name === 'write_file' &&
      `${argString(c, 'path')}::${argString(c, 'content')}` === signature).length;
    return repeats >= 1
      ? deny('同じ内容を再度書こうとしています。別の方法を検討するか、行き詰まりを報告してください。')
      : allow;
  },
};

/**
 * 危険なコマンドを止める。許可リストはツール側にあるが、
 * 「許可されたコマンドの危険な使い方」はここで見る。
 */
export const dangerousCommands: Rule = {
  name: 'dangerous-commands',
  description: '破壊的・不可逆なコマンドを止める',
  pre(call) {
    if (call.name !== 'run_command') return allow;
    const command = argString(call, 'command') ?? '';
    const patterns: Array<[RegExp, string]> = [
      [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.)/i, 'git の破壊的操作'],
      [/\brm\s+-[a-z]*r/i, '再帰削除'],
      [/\bnpm\s+publish\b/i, '公開'],
      [/>\s*\/dev\/(sd|nvme)/i, 'デバイスへの書き込み'],
      [/\bchmod\s+-R\s+777/i, '権限の全開放'],
      [/\b(curl|wget)[^|]*\|\s*(ba)?sh/i, 'ダウンロードしたスクリプトの実行'],
      // ここから Windows。この場所の利用者は Windows で使う。Unix の形だけ
      // 見ていると、同じことを cmd と PowerShell で素通りさせる。
      [/\b(rmdir|rd)\s+(\/s|-r)/i, '再帰削除'],
      [/\bdel\s+(\/[a-z]\s+)*\/s\b/i, '再帰削除'],
      [/\bRemove-Item\b[^|;]*-Recurse/i, '再帰削除'],
      [/\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(iex|Invoke-Expression)/i, 'ダウンロードしたスクリプトの実行'],
      [/\bformat\s+[a-z]:/i, 'ドライブの初期化'],
      [/\b(diskpart|reg\s+delete|shutdown)\b/i, '機械そのものへの操作'],
    ];
    for (const [re, label] of patterns) {
      if (re.test(command)) {
        return deny(`${label}は実行できません: ${command}。必要なら利用者に依頼してください。`);
      }
    }
    return allow;
  },
};

/**
 * 変更後に、その場で気づける情報を差し込む。
 * 「書いた直後に型検査の結果を見せる」のような、
 * 後で分かることを早く分からせる仕掛け。
 */
export function afterWriteHint(hint: (path: string) => string | undefined): Rule {
  return {
    name: 'after-write-hint',
    description: '書き込み直後に注意点を差し込む',
    post(call, result) {
      if (call.name !== 'write_file') return ok;
      if (/^ERROR/.test(result)) return ok;
      const path = argString(call, 'path');
      const note = path ? hint(path) : undefined;
      return note ? { kind: 'inject' as const, note } : ok;
    },
  };
}

function normalize(root: string, path: string): string {
  const abs = safeResolve(root, path);
  if (!abs) return path;
  const rel = relative(root, abs);
  return isAbsolute(rel) ? path : rel.split('\\').join('/');
}

const TEST_FILE = /(\.|_|^)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.go$|(^|\/)tests?\//i;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

const CASE_PATTERNS = [
  /\b(?:test|it)\s*(?:\.\w+)?\s*\(/g,
  /^\s*def\s+test_\w+/gm,
  /\bfunc\s+Test\w+\s*\(/g,
  /^\s*#\[test\]/gm,
];
const SKIP_PATTERNS = [
  /\b(?:test|it|describe)\s*\.\s*skip\s*\(/g,
  /\b(?:xit|xdescribe)\s*\(/g,
  /@(?:pytest\.mark\.)?skip/g,
  /\bt\.Skip\s*\(/g,
];

function countCases(text: string): number {
  let n = 0;
  for (const p of CASE_PATTERNS) n += text.match(p)?.length ?? 0;
  return n;
}

function countSkips(text: string): number {
  let n = 0;
  for (const p of SKIP_PATTERNS) n += text.match(p)?.length ?? 0;
  return n;
}

export type { Rule, RuleContext, ToolCall };
