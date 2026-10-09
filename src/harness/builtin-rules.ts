/**
 * 組み込み規則。
 *
 * それぞれ「モデルがやりがちな誤った選択」に対応している。
 * プロンプトで禁じるのではなく、実行の手前で止める。
 */
import { isWriteTool, isExternalTool, mayWriteFiles, plannedContent } from '../agent/tools/write-kind.ts';
import { lstat } from 'node:fs/promises';
import { relative, isAbsolute, dirname, join, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { minimatch } from './glob.ts';
import { safeResolve, canonicalRel } from '../agent/tools/paths.ts';
import { isAbsent, readRegularText } from './put-back.ts';
import { fingerprint, lastPrint, isFailedWrite, wroteNothing } from './seen.ts';
import { isTestFile, countCases, countSkips, countFocus } from '../agent/test-patterns.ts';
import { type Rule, type RuleContext, allow, deny, ok, argString, hasArg } from './rules.ts';
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
 * 守る道に当たるか。当たった型を返す（当たらなければ undefined）。綴りだけでなく、書いたときに当たる実体でも照らす
 * （Windows の `ENV~1` は `.env`、`g -> .git` の `g/config` は `.git/config`）。Windows は名前の末尾の点・空白と ADS を落としてから照らす。
 * AI の書き込み（下の規則）と画面の手書きで同じものを使う（画面の手書きが守りを通っていなかった）。
 */
export async function matchProtected(
  root: string, path: string, patterns: readonly string[], opts: { nocase?: boolean; windows?: boolean } = {},
): Promise<string | undefined> {
  const name = opts.windows ? windowsName : (p: string): string => p;
  const rel = normalize(root, path);
  const real = await canonicalRel(root, path);
  return patterns.find((p) => minimatch(name(rel), p, opts) || (real !== undefined && minimatch(name(real), p, opts)));
}

/**
 * 触ってはいけないファイルを守る。
 * 「.env を読んで直す」のような、善意で始まる事故を止める。
 */
/**
 * 書いた人の意図する形に揃える。照らす道は作業場からの相対で、頭にも末尾にも `/` が付かないので、`secrets/`（フォルダのつもり）や
 * `/config/**`（作業場の根のつもり）は何にも当たらず、黙って何も守っていなかった。頭の `/`・`./` は外し、末尾の `/` は中身全部（`/**`）にする
 */
export function protectedPattern(pattern: string): string {
  let p = pattern.trim().split('\\').join('/');
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p = `${p}**`;
  return p;
}

export function protectedPaths(given: string[], opts: { nocase?: boolean; windows?: boolean } = {}): Rule {
  const patterns = given.map(protectedPattern).filter((p) => p.length > 0);
  // Windows は名前の末尾の点・空白を落とし、`:` から後ろを流れ（ADS）の名前として読む。`.env `・`id.pem.`・`.env::$DATA` は
  // `.env` や `id.pem` に書かれるのに、綴りのまま照らしていたので当たらなかった。照らす前に、Windows が読む名前に揃える
  const name = opts.windows ? windowsName : (p: string): string => p;
  return {
    name: 'protected-paths',
    description: `保護対象への書き込みを禁じる: ${patterns.join(', ')}`,
    async pre(call, ctx) {
      // 外から来たツールも見る。何をするか分からないものを「書かない側」に
      // 置くと、ここが丸ごと素通りする（`mayWriteFiles`）。
      if (!mayWriteFiles(call.name)) return allow;

      /*
       * **どの引数を見るかは、相手によって変わる。**
       *
       * この場所のツールは `path` で受けると決めてある。外から来たツールの
       * 引数の名前は相手が決めるので、`file` にも `target` にもなるし、
       * 入れ子にも入る。`path` だけを見ていると、名前を変えるだけで通る。
       */
      const collected = isExternalTool(call.name) ? collectStrings(call.args) : undefined;
      // 上限まで集めても見切れないなら、断る側に倒す（残りを見ずに通していたので、無関係な値を 200 個並べた後ろの `.env` が通った）
      if (collected?.truncated) {
        return deny('外のツールへの引数が多すぎる（または深すぎる）ので、守っているファイルに触れないかを確かめられません。引数を分けて呼んでください。');
      }
      const named = collected
        ? collected.out
        : [argString(call, 'path')].filter((p): p is string => p !== undefined);

      for (const path of named) {
        const rel = normalize(ctx.root, path);
        /*
         * 外のツールの値のうち、空白を含む文は、親のフォルダが在る道のときだけ道として見る。既定の守りは `**\/` でどの階層にも当たるので、
         * 「please check packages/api/.env」のような文（最初の区切りが「please check packages」）まで保護された道として止め、
         * issue やコメントに `.env` の話を書けなくしていた。空白を含む本当の道（`My Docs/.env`）は、親のフォルダが在るので今までどおり見る
         */
        // 作業場の外の絶対の道は、そのまま親を見る（作業場の根に繋いでいたので、いつも「無い」になり、空白を含む絶対の道を素通しした）
        if (isExternalTool(call.name) && /\s/.test(path) && !existsSync(isAbsolute(rel) ? dirname(rel) : dirname(join(ctx.root, rel)))) continue;
        // 大小を区別しない機械では `.ENV` も `.env`。区別すると守りをすり抜ける。
        // 綴りだけでなく、書いたときに当たる実体でも照らす（Windows の `ENV~1` は `.env`、`g -> .git` の `g/config` は `.git/config`）
        const hit = await matchProtected(ctx.root, path, patterns, opts);
        if (hit) {
          return deny(isExternalTool(call.name)
            ? `${rel} は保護されています（${hit}）。外のツールには渡せません。`
            : `${rel} は保護されています（${hit}）。このファイルは変更できません。`);
        }
      }
      return allow;
    },
  };
}

/** Windows が実際に作る名前に揃える（各名前の `:` から後ろと、末尾の点・空白を落とす。ドライブの `C:` と `.`・`..` はそのまま）。 */
export function windowsName(path: string): string {
  // `\` 区切りも名前の区切りとして見る（外のツールに渡した `D:\keys\id.pem` を一つの名前と読んで `:` から後ろを落とし、守りを外していた）
  return path.replace(/\\/g, '/').split('/').map((seg, i) => {
    if (i === 0 && /^[A-Za-z]:$/.test(seg)) return seg;
    const bare = seg.includes(':') ? seg.slice(0, seg.indexOf(':')) : seg;
    return bare === '.' || bare === '..' ? bare : bare.replace(/[. ]+$/, '');
  }).join('/');
}

/**
 * 引数の中の文字列を、入れ子まで全部集める。
 *
 * 外から来たツールの引数の形は、相手の schema のまま。こちらでは決められない
 * ので、**名前ではなく値の側を見る。**丸ごと一致で照合するので、文の中に
 * `.env` と混ざっているだけでは当たらない（`test/mcp-protected.test.ts`）。
 *
 * 深さと数に上限を置く。上限が無いと、大きな引数一つで規則の側が止まる。
 */
/** 外のツールの引数を見る深さと数の上限（Notion のブロックや 50 ファイルの push でも収まる大きさ）。 */
const MAX_ARG_DEPTH = 16;
const MAX_ARG_STRINGS = 2000;

function collectStrings(args: unknown): { out: string[]; truncated: boolean } {
  const out: string[] = [];
  let truncated = false;
  const walk = (v: unknown, depth: number): void => {
    if (truncated) return;
    // 上限に当たって見切れるのは、文字やその入れ物が残っているときだけ（数や null の深い所は見なくてよい）
    if (typeof v !== 'string' && (typeof v !== 'object' || v === null)) return;
    if (depth > MAX_ARG_DEPTH || out.length >= MAX_ARG_STRINGS) { truncated = true; return; }
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      // 道を名前に置く形（`{"files":{".env":"…"}}`）も見る。ただし道の形をした名前だけ（`credentials` のような普通の項目名で止めない）
      if (/[\\/]|^\./.test(k)) {
        if (out.length >= MAX_ARG_STRINGS) { truncated = true; return; }
        out.push(k);
      }
      walk(x, depth + 1);
    }
  };
  walk(args, 0);
  return { out, truncated };
}

/** テストの数を確かめられなかった理由の文。待っても直らないもの（大きすぎる・普通のファイルでない）に「待って」と言わない。 */
function unreadableTest(path: string, e: NodeJS.ErrnoException): string {
  if (e.code === 'EFBIG' || e.code === 'ENOTFILE') {
    return `${path} は${e.code === 'EFBIG' ? '大きすぎて' : '普通のファイルではないので'}、テストが減らないかを確かめられません。書き換えは利用者に依頼してください。`;
  }
  return `${path} を読めないので、テストが減らないかを確かめられません（${e.code ?? e.message}）。少し待ってからやり直してください。`;
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
    if (!isWriteTool(call.name)) return allow;
    const path = argString(call, 'path');
    if (!path) return allow;
    // 綴りが試験に見えなくても、当たる実体が試験なら守る（Windows の 8.3 の名前 `FOOTES~1.TS` は `foo.test.ts`）
    if (!isTestFile(path)) {
      const real = await canonicalRel(ctx.root, path);
      if (real === undefined || !isTestFile(real)) return allow;
    }
    // **当ててから見る。**edit_file は引数に「後の姿」が入っていない。
    // 引数だけ見ていると、部分置換でテストを消すのを素通りさせる。
    const content = await plannedContent(call.name, call.args, ctx.root).catch((e: unknown) => e as Error);
    // 読めなくて当てられないのを「後の姿が分からない」と読んで通さない
    if (content instanceof Error) {
      return deny(unreadableTest(path, content as NodeJS.ErrnoException));
    }
    if (content === undefined) return allow;

    const abs = safeResolve(ctx.root, path);
    if (!abs) return allow; // 範囲外は別の規則が止める

    let before: string;
    try {
      before = await readRegularText(abs);
    } catch (e) {
      if (isAbsent(e)) return allow; // 新規作成は歓迎
      // 読めないのを「新しいファイル」と読まない。書く時点で掴みが外れていると、テストを減らす書き込みが通る
      return deny(unreadableTest(path, e as NodeJS.ErrnoException));
    }

    const was = countCases(before);
    const now = countCases(content);
    if (now < was) {
      return deny(
        `${path} のテストが ${was} 件から ${now} 件に減っています。` +
        'テストを消して通すことはできません。実装側を直してください。',
      );
    }
    // 新しく足したテストの分までは skip・todo を許す（`test.todo('…')` を足すのは、今あるテストを無効にしない）
    const skipsAdded = countSkips(content) - countSkips(before) - (now - was);
    if (skipsAdded > 0) {
      return deny(
        `${path} に skip が ${skipsAdded} 件増えています。` +
        'テストを無効化して通すことはできません。実装側を直してください。',
      );
    }
    const focusAdded = countFocus(content) - countFocus(before);
    if (focusAdded > 0) {
      return deny(
        `${path} に only（絞り込み）が ${focusAdded} 件増えています。他のテストが走らなくなります。` +
        '絞り込みを外して、実装側を直してください。',
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
      if (!isWriteTool(call.name)) return allow;
      const path = argString(call, 'path');
      if (!path) return allow;

      // 道は揃えて数える（`./a.ts` と `a.ts` を二件と数えない）
      // 依頼全体で数える（段取りで並べた担当の分も。担当ごとに数えると、担当の数だけ上限が増える）
      const written = new Set(
        (ctx.taskHistory ?? ctx.history)
          // 何も書かずに終わったもの（断られた・失敗した）は、書き換えた件数に数えない
          .filter((c) => isWriteTool(c.name) && !wroteNothing(c))
          .map((c) => argString(c, 'path'))
          .filter((p): p is string => !!p)
          .map((p) => normalize(ctx.root, p)),
      );
      if (written.has(normalize(ctx.root, path)) || written.size < maxFiles) return allow;

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
 * 既存ファイルを read_file せずに全文で上書きすると、知らない内容を消す。
 * write_file は全文渡しなので、これは実際に起きる。
 *
 * **見ていたのは「そのファイルを読んだか」ではなかった。**
 * `search_text` を一度でも呼んでいれば通していた——探した言葉も、
 * 当たったファイルも見ずに。`search_text` の結果に**そのファイルが
 * 一件も出ていなくても通る**ので、無関係な検索一回で全文上書きが素通りする。
 * 守っているつもりで、守っていない形。名指しで読んだことだけを見る。
 *
 * `read_file` に `offset` / `limit` が付いたので、**一部だけ読んだ**ことも
 * 起きる。全文を置き換える `write_file` では、それは読んだことにしない
 * （読んでいない行を消すのが、この規則が止めたいこと）。`edit_file` は
 * 当てた所だけを替えるので、一部だけ読んでいれば足りる。
 *
 * **残っているところ。**規則には呼び出しだけが渡り、結果は渡らない。だから
 * `offset` を渡していない読みが、コンテキストウィンドウで切られていたかは
 * ここでは分からない。切られた分を消す形は、まだ止められない。
 */
export const readBeforeWrite: Rule = {
  name: 'read-before-write',
  description: '既存ファイルを読まずに上書きさせない',
  async pre(call, ctx) {
    if (!isWriteTool(call.name)) return allow;
    const path = argString(call, 'path');
    if (!path) return allow;

    const abs = safeResolve(ctx.root, path);
    if (!abs) return allow;
    // 新規作成は読みようがない。**見られないのを「無い」と読まない。**読むと、在るファイルを読まずに全文で上書きさせる
    const seen = await lstat(abs).then(() => 'there' as const, (e: unknown) => (isAbsent(e) ? 'absent' as const : e as Error));
    if (seen === 'absent') return allow;
    if (seen instanceof Error) {
      return deny(`${path} を見られないので、読んだかを確かめられません（${(seen as NodeJS.ErrnoException).code ?? seen.message}）。少し待ってからやり直してください。`);
    }

    /** 一部だけを読んだ呼び出しか。 */
    const partial = (c: ToolCall): boolean => hasArg(c, 'offset') || hasArg(c, 'limit');
    const wholeNeeded = call.name === 'write_file';
    // 前に書いたことも「見た」に数える。ただし全文を置き換えるときは、前に全文を書いた（write_file）ときだけ。edit_file は当てた所しか
    // 知らない（失敗して何も書いていないこともある）。数えていたので、一部だけ読んで edit_file を一度（失敗でも）挟むと、全文の
    // write_file が通り、読んでいない行を消していた
    // 道は揃えて比べる（`a.ts` を読んで `./a.ts` に書くのを、読んでいないと取り違えない）
    const target = normalize(ctx.root, path);
    const same = (c: ToolCall): boolean => {
      const p = argString(c, 'path');
      return p !== undefined && normalize(ctx.root, p) === target;
    };
    const sawIt = ctx.history.some((c) =>
      (c.name === 'read_file' && same(c)
        && !(wholeNeeded && partial(c)))
      || (isWriteTool(c.name) && !wroteNothing(c) && same(c) && (!wholeNeeded || c.name === 'write_file')));
    if (sawIt) {
      if (!wholeNeeded) return allow; // edit_file は当てる所が見つからなければ失敗するので、古い中身で消すことは無い
      // 最後に読んだ・書いたときから中身が替わっていれば、読み直させる（別の担当や run_command の変更を、古い中身で消さない）
      const was = lastPrint(ctx.history, ctx.root, path);
      // 見た中身の指紋が無い（読んでいる間に替わった・大きすぎて指紋を取れなかった）。見た中身が分からないので、読み直させる
      if (was === undefined) {
        return deny(`${path} を読んだときの中身を確かめられません（読んでいる間に替わった可能性があります）。read_file で読み直してから書いてください。`);
      }
      const now = await fingerprint(ctx.root, path);
      if (now === was) return allow;
      if (now === undefined) {
        return deny(`${path} を読めないので、読んだ後で替わっていないかを確かめられません。少し待ってからやり直してください。`);
      }
      return deny(
        `${path} は、最後に読んだ後で中身が替わっています（別の担当や run_command が替えた可能性があります）。` +
        'このまま全文を書くと、その変更が消えます。read_file で読み直してから書いてください。',
      );
    }

    const partly = ctx.history.some((c) =>
      c.name === 'read_file' && same(c) && partial(c));
    if (partly) {
      return deny(
        `${path} は一部しか読んでいません。write_file は全文を置き換えるため、` +
        '読んでいない行が消えます。offset を外して読み直すか、edit_file で直してください。',
      );
    }
    return deny(
      `${path} をまだ読んでいません。write_file は全文を置き換えるため、` +
      '先に read_file で現在の内容を確認してください。',
    );
  },
};

/** 引数の中身を一つの文字列にする（同じ呼び出しかを見るため）。文字列にできないものは、その都度違うものとして扱う。 */
let unsignable = 0;
function signArgs(args: unknown): string {
  // キーの順は揃える（同じ中身をキーの順だけ変えて出し直すと、別の呼び出しとして通ってしまう）
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
      : v;
  try { return JSON.stringify(sorted(args ?? null)); } catch { return `unsignable:${++unsignable}`; }
}

/**
 * 同じ書き込みの繰り返しを止める。
 * 直したつもりで同じ内容を書き続けるのは、行き詰まりの典型。
 */
export const noRepeatedWrites: Rule = {
  name: 'no-repeated-writes',
  description: '同一内容の書き込みの繰り返しを止める',
  pre(call, ctx) {
    if (!isWriteTool(call.name)) return allow;
    // 同じ呼び出しかどうかは、**渡された引数そのもの**で見る。
    // ここで当て直すと、当てるたびに中身が変わる（一度目で書き換わるので、
    // 二度目は「見つからない」になる）。繰り返しを見るには引数の方が正しい。
    // **引数の全部で見る。**名前を挙げた一部（path・content・find・replace）で見ていたので、まとめて直す `edits` だけの
    // edit_file は、中身が違っても二度目から「同じ内容」として止めていた（ツールの説明が勧める、いちばん普通の使い方）
    const sign = (c: ToolCall) => `${c.name}::${signArgs(c.args)}`;
    const signature = sign(call);
    // 失敗した書き込み（何も書いていない）は数えない。「待っている間に変わりました。読み直してもう一度書いて」や EBUSY の後の
    // 出し直しは、同じ引数になるのが普通で、それを止めていた
    const repeats = ctx.history.filter((c) =>
      isWriteTool(c.name) && !isFailedWrite(c) && sign(c) === signature).length;
    return repeats >= 1
      ? deny('同じ内容を再度書こうとしています。別の方法を検討するか、行き詰まりを報告してください。')
      : allow;
  },
};

/**
 * 呼び出しが走らせる命令。run_command の `command` と、外のツール（MCP）の命令を走らせる口（Desktop Commander の
 * `start_process` など）の引数の一段目の `command`・`cmd`・`script`。外のツールに当てていなかったので、
 * `{"command":"git push --force"}` や `pkill -f node` を規則に掛けずに通した。一段目の鍵の名前で絞る
 * （issue の本文などに命令の話を書いただけで止めない）。どちらでもなければ undefined
 */
export function commandOf(call: ToolCall): string | undefined {
  if (call.name === 'run_command') return argString(call, 'command') ?? '';
  if (!isExternalTool(call.name) || call.args === null || typeof call.args !== 'object' || Array.isArray(call.args)) return undefined;
  const args = call.args as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
    // 命令を語の並びで渡す口（`{"command":["git","push"]}`）も、つないだ形で見る
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) return v.join(' ');
  }
  return undefined;
}

/**
 * 危険なコマンドを止める。許可リストはツール側にあるが、
 * 「許可されたコマンドの危険な使い方」はここで見る。
 */
export const dangerousCommands: Rule = {
  name: 'dangerous-commands',
  description: '破壊的・不可逆なコマンドを止める',
  pre(call) {
    const command = commandOf(call);
    if (command === undefined) return allow;
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
    // 殻が綴りを組み替える形（cmd の `pu^sh`、sh の `pu''sh`・`pu\sh`・`pu"sh"`）も、組み替えた後の綴りで照らす
    const flat = unshell(command);
    // 語の頭の引用符（`git "p"ush`・`git 'pu'sh`）も組み替えた後は同じ語になる。引用符を全部外した形でも照らす
    const bare = flat.replace(/['"]/g, '');
    for (const [re, label] of patterns) {
      if (re.test(command) || re.test(flat) || re.test(bare)) {
        return deny(`${label}は実行できません: ${command}。必要なら利用者に依頼してください。`);
      }
    }
    const git = gitDanger(command) ?? gitDanger(flat) ?? gitDanger(bare);
    if (git) return deny(`git の破壊的操作（${git}）は実行できません: ${command}。必要なら利用者に依頼してください。`);
    return allow;
  },
};

/** git の全体の選択肢のうち、次の語を値として取るもの（`git -C dir push` の `dir`）。 */
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/**
 * git の破壊的な操作か。当たればその名前、当たらなければ undefined。
 *
 * 決まった並び（`git clean -f`・`git reset --hard`）を正規表現で見ていたので、並びを変える（`git clean -x -d -f`・`git reset -q --hard`）、
 * 全体の選択肢を挟む（`git -C . push`・`git -c x=y push`）、長い名前にする（`git clean --force`）だけで素通りした。`git clean -x -d -f` は
 * 無視している `.env` まで消し、外で変わった記録（OutsideChanges）にも載らないので「戻す」でも戻らない。
 * 繋いだ命令は一つずつ、語に分けて、全体の選択肢を飛ばしてから、サブコマンドと選択肢を並びに関わらず見る。
 */
/**
 * 殻が組み替えた後の綴りに近づける（照らすためだけ。走らせる命令は変えない）。cmd の `^`、sh の `\` と空の引用符・語の中の引用符を外す。
 */
export function unshell(command: string): string {
  return command
    .replace(/\^(?=.)/g, '')
    .replace(/\\(?=[A-Za-z])/g, '')
    .replace(/''|""/g, '')
    .replace(/(?<=[\w-])(['"])([^'"\s]*)\1/g, '$2');
}

/** git を動かした所で命令を走らせる設定の鍵。 */
const CONFIG_RUNS = /^(core\.(hookspath|fsmonitor|pager|sshcommand|editor|askpass|gitproxy)|filter\.|diff\.external|diff\.[^=\s]*\.(textconv|command)|merge\.[^=\s]*\.driver|include\.path|includeif\.[^=\s]*\.path|credential\.helper|credential\.[^=\s]*\.helper|sequence\.editor|gpg\.program|gpg\.[^=\s]*\.program|pager\.|alias\.)/i;

/**
 * `git config` の残りの語が、命令を走らせる設定を書くか。消す（`--unset`）・読む（`--get`・`get`・`list`・値の無い鍵だけ）は書かない。
 * 書くのは、鍵の後ろに値があるとき、`--add`・`--replace-all`・`set` のとき、`--edit` のとき。
 */
function configWritesRunner(rest: readonly string[]): boolean {
  const flags = rest.filter((w) => w.startsWith('-')).map((w) => w.toLowerCase());
  // 値を後ろに取る選択肢（`-f .git/config`）の値は、鍵ではない（鍵として読んでいたので、`git config -f .git/config alias.p push` が通った）
  const TAKES_VALUE = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment']);
  const plain = rest.filter((w, i) => !w.startsWith('-') && !TAKES_VALUE.has((rest[i - 1] ?? '').toLowerCase()));
  if (flags.some((f) => f === '--edit' || f === '-e') || plain[0]?.toLowerCase() === 'edit') return true;
  if (flags.some((f) => /^(--unset(-all)?|--get(-all|-regexp|-urlmatch|-color|colorbool)?|--list|-l|--remove-section|--show-origin|--show-scope|--name-only)$/.test(f))) return false;
  let words = plain;
  const verb = words[0]?.toLowerCase();
  if (verb === 'get' || verb === 'list' || verb === 'unset' || verb === 'remove-section') return false;
  const setting = verb === 'set';
  if (setting) words = words.slice(1);
  const key = words[0];
  if (!key || !CONFIG_RUNS.test(key.replace(/^['"]|['"]$/g, ''))) return false;
  return setting || words.length >= 2 || flags.some((f) => f === '--add' || f === '--replace-all');
}

export function gitDanger(command: string, depth = 0): string | undefined {
  // 別名の中身を見るのは二段まで（別名を何十も並べると、中身を見るたびに残りの別名をまた見るので、数が増えるほど長くなる）
  if (depth > 2) return undefined;
  for (const part of command.split(/\|\||&&|;|\n|\|(?!&)|(?<![>])&(?!&)/)) {
    // 括弧・$( ・` で包んだ形（`(git -C . push)`）も、包みを外して語にする
    const words = part.trim().split(/\s+/).map((w) => w.replace(/^(\$?\(|`)+/, '').replace(/[)`]+$/, '').replace(/^['"]|['"]$/g, '')).filter((w) => w.length > 0);
    const at = words.findIndex((w) => /(^|[\\/])git(\.exe)?$/i.test(w));
    if (at < 0) continue;
    let i = at + 1;
    const aliases: string[] = [];
    while (i < words.length && words[i]!.startsWith('-')) {
      const w = words[i]!;
      // `-c alias.x='reset --hard'` の別名は、中身も見る（別名にすると並びでは見えない）
      if (w === '-c' && /^alias\./i.test(words[i + 1] ?? '')) aliases.push(words.slice(i + 1).join(' '));
      // 別名のほかに、命令を走らせる設定をその場で渡す形（`-c core.pager=…`・`-c core.hooksPath=…`・`--config-env`）
      else if ((w === '-c' || w === '--config-env') && CONFIG_RUNS.test((words[i + 1] ?? '').replace(/^['"]/, ''))) return '命令を走らせる設定をその場で渡す';
      else if (/^--config-env=/i.test(w) && CONFIG_RUNS.test(w.slice('--config-env='.length))) return '命令を走らせる設定をその場で渡す';
      i += GIT_OPTS_WITH_VALUE.has(w) ? 2 : 1;
    }
    for (const a of aliases) {
      const body = a.replace(/^alias\.[^=]*=/i, '').replace(/^['"]/, '');
      const inner = gitDanger(`git ${body}`, depth + 1);
      if (inner) return `別名の ${inner}`;
    }
    const sub = words[i]?.toLowerCase();
    const rest = words.slice(i + 1);
    // 変数で組んだサブコマンド（`git %X%push`・`git ${x:-push}`）は、殻が展開するまで何になるか分からない
    if (sub && /[%$]/.test(sub)) return '変数で組んだサブコマンド';
    // 命令を走らせる設定を書く（`git config alias.p push` の後の `git p`、hooksPath・fsmonitor・pager・filter は git を動かした所で命令を走らせる）
    if (sub === 'config' && configWritesRunner(rest)) return '命令を走らせる設定の書き換え';
    const shortFlag = (ch: string) => rest.some((w) => /^-[a-z]+$/i.test(w) && w.slice(1).includes(ch));
    // git は長い名前の省略を受け付ける（`--har` は `--hard`）。`--` の後ろ 3 字以上の頭が一致すれば同じとみなす
    const long = (name: string) => rest.some((w) => {
      const key = w.split('=')[0]!;
      return key === name || (key.startsWith('--') && key.length >= 5 && name.startsWith(key));
    });
    // `:(top)` は包みを外すときに閉じ括弧が落ちて `:(top` になる。どちらも作業場全体
    const wholeTree = rest.some((w) => w === '.' || w === './' || w === '*' || w === ':/' || w === ':(top)' || w === ':(top');
    if (sub === 'push') return 'push';
    // push と同じことをする別のサブコマンド（`send-pack`・`http-push`・`subtree push`）
    if (sub === 'send-pack' || sub === 'http-push' || (sub === 'subtree' && rest[0]?.toLowerCase() === 'push')) return 'push';
    // 作業ツリーを戻す別のサブコマンド（`checkout-index -f`・`read-tree --reset -u`）。reset --hard と同じく、まだ記録していない直しを消す
    if (sub === 'checkout-index' && (shortFlag('f') || long('--force'))) return 'checkout-index -f';
    if (sub === 'read-tree' && (shortFlag('u') || rest.includes('-u')) && (long('--reset') || shortFlag('m'))) return 'read-tree -u';
    if (sub === 'switch' && (shortFlag('f') || long('--force') || long('--discard-changes'))) return 'switch -f';
    if (sub === 'reset' && long('--hard')) return 'reset --hard';
    if (sub === 'clean' && (shortFlag('f') || long('--force'))) return 'clean -f';
    // restore は --staged（-S）だけなら索引を戻すだけで、作業ツリーには触らない（--worktree・-W が付けば触る）
    const worktree = sub !== 'restore' || !(long('--staged') || shortFlag('S')) || long('--worktree') || shortFlag('W');
    if ((sub === 'checkout' || sub === 'restore') && worktree && (wholeTree || long('--force') || (sub === 'checkout' && shortFlag('f')))) return `${sub} .`;
  }
  return undefined;
}

/**
 * 自分を殺す命令を止める。
 *
 * `pkill -f node` のような形は、**動かしている自分にも当たる**。
 * 当たると、その場で全部終わる。落ちたのか消したのかも分からず、
 * 利用者からは「また止まった」に見える（実際に二度やった）。
 *
 * 止める相手は、控えた PID で名指しする。**当たり判定を文字列に任せない。**
 */
export const noSelfKill: Rule = {
  name: 'no-self-kill',
  description: '自分にも当たる止め方を防ぐ',
  pre(call) {
    const command = commandOf(call);
    if (command === undefined) return allow;
    // 文字列で相手を探して殺す形。ここに自分が入っていると、自分が死ぬ。
    const wide = /\b(pkill|pgrep)\s+(-[a-z]*f|--full)\b|\bkillall\b|\btaskkill\b[^|]*\/(f|im)\b/i;
    if (!wide.test(command)) return allow;
    // 自分の命令行にも入っている語。これらを的にすると、自分に当たる。
    const selfWords = /\b(node|npm|npx|deno|bun|python3?|sh|bash|cmd|powershell)\b|AdaptiveAIStudio|\.ts\b|\.mjs\b/i;
    if (!selfWords.test(command)) return allow;
    return deny(
      `自分にも当たる止め方です: ${command}。`
      + '控えておいた PID を名指しして止めてください（例: kill 12345）。'
      + '文字列で探して殺すと、動かしているこちらごと落ちます。',
    );
  },
};

/**
 * 断りなく CI を回さない。
 *
 * 実行の枠には実費がかかる。使い切ると、その日は何も確かめられなくなる
 * （実際に一日潰した）。手元で確かめられることを、外で確かめない。
 */
export const noCiSpend: Rule = {
  name: 'no-ci-spend',
  description: '断りのない CI 実行を止める',
  pre(call) {
    const command = commandOf(call);
    if (command === undefined) return allow;
    const patterns: Array<[RegExp, string]> = [
      [/\bgh\s+workflow\s+run\b/i, 'CI を手で回す'],
      [/\bgh\s+run\s+(rerun|watch)\b/i, 'CI を回し直す'],
      [/\bact\b\s+(-|push|pull_request)/i, 'CI をこの場で回す'],
    ];
    for (const [re, label] of patterns) {
      if (re.test(command)) {
        return deny(
          `${label}のは、利用者に断ってからにしてください: ${command}。`
          + '枠には実費がかかり、使い切るとその日は何も確かめられなくなります。'
          + '手元で確かめられることは、手元で確かめてください。',
        );
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
      if (!isWriteTool(call.name)) return ok;
      if (/^ERROR/.test(result)) return ok;
      const path = argString(call, 'path');
      const note = path ? hint(path) : undefined;
      return note ? { kind: 'inject' as const, note } : ok;
    },
  };
}

/** 書いた道を、数えるために揃える（`./a.ts` と `a.ts` を一件にする）。範囲の外はそのまま返す。 */
export function normalize(root: string, path: string): string {
  const abs = safeResolve(root, path);
  if (!abs) return path;
  const rel = relative(root, abs);
  // 区切りは、動いている機械のものだけを揃える（Linux・macOS では `\` は名前の一文字で、`sub\a.ts` は `sub/a.ts` とは別のファイル）
  return isAbsolute(rel) ? path : rel.split(sep).join('/');
}

export { isTestFile };

export type { Rule, RuleContext, ToolCall };
