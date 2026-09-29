/**
 * 読めない失敗を黙って「無い・空」にする書き方を、新しく持ち込ませない。
 *
 * 2026-09-29 に、`readFile(...).catch(() => undefined)` のような読み方から来る不具合を十数件直した（#108〜#117）。
 * 権限・掴まれている・フォルダだった、を「無い」と読み、そこから消す・書き直す・済んだことにする・諦める、に進んでいた。
 * 直し方はどれも同じで、「無い」（ENOENT・ENOTDIR）だけを空にし、ほかは投げるか「分からない」に回す
 * （`src/harness/put-back.ts` の `readPrior` と `isAbsent`）。
 *
 * ここでは、その書き方（readFile・stat・lstat・readdir・open の失敗を空の値にする `.catch(() => …)`）をファイルごとに数える。
 * 下の一覧に「なぜ黙って空にしてよいか」を書くまで落とす。数が増えても落とす（同じファイルに新しく足したときも見直す）。
 * 一覧に書くのは、読めないときに消す・書き直す・状態を進めることが無いと確かめた後。
 *
 * 数えるのは一行に収まる形だけ（`try { … } catch { return [] }` は数えない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const root = join(import.meta.dirname, '..');

/** 黙って空にしてよいファイルと、その数・理由。 */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'src/runtime/cleanup.ts': { count: 18, why: '片づけの候補を探すだけ。読めないものは候補に入らず、消さない側に倒れる' },
  'src/cli/report.ts': { count: 5, why: '報告に載せるだけ。読めなければ載らない' },
  'src/ui/preview.ts': { count: 3, why: '画面に見せるだけ。読めなければ見せられないと出す' },
  'src/core/undo.ts': { count: 3, why: '戻した差分を見せる文字・一覧・更新時刻。更新時刻が取れないものは「挟まっているかもしれない」として止める側（#115）' },
  'src/agent/prefetch.ts': { count: 3, why: 'ファイル一覧と錠の在る無しの下調べ。読めないものは一覧に載らないだけ（動かし方は別に厳しく読む、#116）' },
  'src/agent/initiative.ts': { count: 3, why: '思いつきの手がかり集め。読めないものは手がかりにしない' },
  'src/ui/server.ts': { count: 2, why: 'ファイルの情報を見せる所と、作業場にするフォルダの確かめ（読めなければ選べない側）' },
  'src/ui/attachments.ts': { count: 2, why: '添付の古い分の片づけの候補探し。読めないものは消さない' },
  'src/runtime/inproc.ts': { count: 2, why: 'モデルの大きさを見るだけ。取れなければ大きさを言わない' },
  'src/harness/builtin-rules.ts': { count: 2, why: '規則は通すが、書くツールが読めないファイルに書かない（#111）ので、そこで止まる' },
  'src/core/version.ts': { count: 2, why: '版の表示。読めなければ分からないと出す' },
  'src/core/logfile.ts': { count: 2, why: '記録の大きさ（回すかどうか）と末尾の表示。読めなくても書き直さない' },
  'src/agent/commands.ts': { count: 2, why: '利用者が置いたコマンドの定義を読む。読めないものは一覧に出さない' },
  'src/ui/settings.ts': { count: 1, why: '保存先のフォルダの状態を見せるだけ' },
  'src/runtime/llama-install.ts': { count: 1, why: '取り出した実行ファイルの在る無し。掴まれていれば書き出しの方が落ちる' },
  'src/agent/workspace-stamp.ts': { count: 1, why: '変化を見つけるための大きさと時刻。取れなければ変わったと数える側' },
  'src/agent/tools/write-kind.ts': { count: 1, why: '書く種類の判定。書くツールが読めないファイルに書かない（#111）' },
  'src/agent/outside-changes.ts': { count: 1, why: '読めなければ記録できなかった道にする（「無い」とは読まない）' },
};

const LENIENT = /\b(readFile|stat|lstat|readdir|open)\([^)]*\)[^;]*\.catch\(\(\) => (undefined|\[\]|''|0|false|null|\{\}|Buffer\.alloc\(0\))\)/g;

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...await sources(path));
    else if (/\.(ts|js|mjs)$/.test(e.name)) out.push(path);
  }
  return out;
}

/** 注釈の行を除いた中身。注釈に書いた例で数えない。 */
function codeOnly(text: string): string {
  return text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

test('読めない失敗を黙って空にする書き方は、一覧に理由を書いたファイルに、書いた数だけ', async () => {
  const found = new Map<string, number>();
  for (const abs of await sources(join(root, 'src'))) {
    const rel = relative(root, abs).split(sep).join('/');
    const n = codeOnly(await readFile(abs, 'utf8')).match(LENIENT)?.length ?? 0;
    if (n > 0) found.set(rel, n);
  }
  const problems: string[] = [];
  for (const [rel, n] of found) {
    const allowed = ALLOWED[rel];
    if (!allowed) {
      problems.push(`${rel}: ${n} か所。「無い」だけを空にする（readPrior・isAbsent）か、読めないときに消す・書き直す・状態を進めないと確かめて一覧に理由を書く`);
    } else if (n > allowed.count) {
      problems.push(`${rel}: ${allowed.count} か所のはずが ${n} か所。増えた所を見直す`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('一覧に、もう無いファイル・減った数を残さない（直した所を一覧が隠さないように）', async () => {
  const stale: string[] = [];
  for (const [rel, { count }] of Object.entries(ALLOWED)) {
    const text = await readFile(join(root, rel), 'utf8').catch(() => undefined);
    const n = text === undefined ? 0 : codeOnly(text).match(LENIENT)?.length ?? 0;
    if (n < count) stale.push(`${rel}: 一覧は ${count} か所、いまは ${n} か所`);
  }
  assert.deepEqual(stale, [], stale.join('\n'));
});
