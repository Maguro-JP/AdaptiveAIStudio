/**
 * 組み込み規則。
 *
 * それぞれ「モデルがやりがちな誤った選択」に対応している。
 * プロンプトで禁じるのではなく、実行の手前で止める。
 */
import { isWriteTool, isExternalTool, mayWriteFiles, plannedContent } from '../agent/tools/write-kind.ts';
import { readFile, lstat } from 'node:fs/promises';
import { relative, isAbsolute, dirname, join, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { minimatch } from './glob.ts';
import { safeResolve } from '../agent/tools/paths.ts';
import { isAbsent } from './put-back.ts';
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
 * 触ってはいけないファイルを守る。
 * 「.env を読んで直す」のような、善意で始まる事故を止める。
 */
export function protectedPaths(patterns: string[], opts: { nocase?: boolean } = {}): Rule {
  return {
    name: 'protected-paths',
    description: `保護対象への書き込みを禁じる: ${patterns.join(', ')}`,
    pre(call, ctx) {
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
      const named = isExternalTool(call.name)
        ? stringsIn(call.args)
        : [argString(call, 'path')].filter((p): p is string => p !== undefined);

      for (const path of named) {
        const rel = normalize(ctx.root, path);
        /*
         * 外のツールの値のうち、空白を含む文は、親のフォルダが在る道のときだけ道として見る。既定の守りは `**\/` でどの階層にも当たるので、
         * 「please check packages/api/.env」のような文（最初の区切りが「please check packages」）まで保護された道として止め、
         * issue やコメントに `.env` の話を書けなくしていた。空白を含む本当の道（`My Docs/.env`）は、親のフォルダが在るので今までどおり見る
         */
        if (isExternalTool(call.name) && /\s/.test(path) && !existsSync(dirname(join(ctx.root, rel)))) continue;
        // 大小を区別しない機械では `.ENV` も `.env`。区別すると守りをすり抜ける。
        const hit = patterns.find((p) => minimatch(rel, p, opts));
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

/**
 * 引数の中の文字列を、入れ子まで全部集める。
 *
 * 外から来たツールの引数の形は、相手の schema のまま。こちらでは決められない
 * ので、**名前ではなく値の側を見る。**丸ごと一致で照合するので、文の中に
 * `.env` と混ざっているだけでは当たらない（`test/mcp-protected.test.ts`）。
 *
 * 深さと数に上限を置く。上限が無いと、大きな引数一つで規則の側が止まる。
 */
function stringsIn(args: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || out.length >= 200) return out;
  if (typeof args === 'string') { out.push(args); return out; }
  if (Array.isArray(args)) {
    for (const v of args) stringsIn(v, depth + 1, out);
    return out;
  }
  if (typeof args === 'object' && args !== null) {
    for (const v of Object.values(args as Record<string, unknown>)) stringsIn(v, depth + 1, out);
  }
  return out;
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
    if (!path || !isTestFile(path)) return allow;
    // **当ててから見る。**edit_file は引数に「後の姿」が入っていない。
    // 引数だけ見ていると、部分置換でテストを消すのを素通りさせる。
    const content = await plannedContent(call.name, call.args, ctx.root).catch((e: unknown) => e as Error);
    // 読めなくて当てられないのを「後の姿が分からない」と読んで通さない
    if (content instanceof Error) {
      return deny(`${path} を読めないので、テストが減らないかを確かめられません（${(content as NodeJS.ErrnoException).code ?? content.message}）。少し待ってからやり直してください。`);
    }
    if (content === undefined) return allow;

    const abs = safeResolve(ctx.root, path);
    if (!abs) return allow; // 範囲外は別の規則が止める

    let before: string;
    try {
      before = await readFile(abs, 'utf8');
    } catch (e) {
      if (isAbsent(e)) return allow; // 新規作成は歓迎
      // 読めないのを「新しいファイル」と読まない。書く時点で掴みが外れていると、テストを減らす書き込みが通る
      return deny(`${path} を読めないので、テストが減らないかを確かめられません（${(e as Error).message}）。少し待ってからやり直してください。`);
    }

    const was = countCases(before);
    const now = countCases(content);
    if (now < was) {
      return deny(
        `${path} のテストが ${was} 件から ${now} 件に減っています。` +
        'テストを消して通すことはできません。実装側を直してください。',
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
      if (!isWriteTool(call.name)) return allow;
      const path = argString(call, 'path');
      if (!path) return allow;

      // 道は揃えて数える（`./a.ts` と `a.ts` を二件と数えない）
      const written = new Set(
        ctx.history
          .filter((c) => isWriteTool(c.name))
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
      || (isWriteTool(c.name) && same(c) && (!wholeNeeded || c.name === 'write_file')));
    if (sawIt) return allow;

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
    const repeats = ctx.history.filter((c) =>
      isWriteTool(c.name) && sign(c) === signature).length;
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
    const git = gitDanger(command);
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
export function gitDanger(command: string): string | undefined {
  for (const part of command.split(/\|\||&&|;|\n|\|(?!&)|(?<![>])&(?!&)/)) {
    const words = part.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, '')).filter((w) => w.length > 0);
    const at = words.findIndex((w) => /(^|[\\/])git(\.exe)?$/i.test(w));
    if (at < 0) continue;
    let i = at + 1;
    while (i < words.length && words[i]!.startsWith('-')) {
      const w = words[i]!;
      i += GIT_OPTS_WITH_VALUE.has(w) ? 2 : 1;
    }
    const sub = words[i]?.toLowerCase();
    const rest = words.slice(i + 1);
    const shortFlag = (ch: string) => rest.some((w) => /^-[a-z]+$/i.test(w) && w.slice(1).includes(ch));
    const long = (name: string) => rest.some((w) => w === name || w.startsWith(`${name}=`));
    const wholeTree = rest.some((w) => w === '.' || w === '*' || w === ':/' || w === ':(top)');
    if (sub === 'push') return 'push';
    if (sub === 'reset' && long('--hard')) return 'reset --hard';
    if (sub === 'clean' && (shortFlag('f') || long('--force'))) return 'clean -f';
    if ((sub === 'checkout' || sub === 'restore') && (wholeTree || long('--force') || (sub === 'checkout' && shortFlag('f')))) return `${sub} .`;
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
    if (call.name !== 'run_command') return allow;
    const command = argString(call, 'command') ?? '';
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
    if (call.name !== 'run_command') return allow;
    const command = argString(call, 'command') ?? '';
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

function normalize(root: string, path: string): string {
  const abs = safeResolve(root, path);
  if (!abs) return path;
  const rel = relative(root, abs);
  // 区切りは、動いている機械のものだけを揃える（Linux・macOS では `\` は名前の一文字で、`sub\a.ts` は `sub/a.ts` とは別のファイル）
  return isAbsolute(rel) ? path : rel.split(sep).join('/');
}

const TEST_FILE = /(\.|_|^)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.go$|(^|\/)tests?\//i;

export function isTestFile(path: string): boolean {
  // `tests\test_api.py` のような `\` 区切りの道も見る（`/` だけを見ていたので、試験を守る規則を素通りした）
  return TEST_FILE.test(path.replace(/\\/g, '/'));
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
