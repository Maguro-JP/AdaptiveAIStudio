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
  'src/runtime/cleanup.ts': { count: 23, why: '片づけの候補探しと大きさ（脇へ移した前の版も、新しさを取れなければ候補にしない）（.part.tag の隣の .part が読めなければ、途中の分が無いとみなして .tag を候補にする）（コードの索引のフォルダと、その中のファイルも同じ）。読めないものは候補に入らない（.part は新しさを取れなければ候補にしない＝消さない側）。ただし名前だけで候補になるもの（古い llama-server）は、大きさを取れないと 0 と数える（消す量を少なく言う）' },
  'src/cli/report.ts': { count: 7, why: '報告に載せるだけ。読めなければ載らない' },
  'src/ui/preview.ts': { count: 4, why: '画面に見せるだけ。読めなければ見せられないと出す（index.html が見られなければ一覧を見せる）' },
  'src/core/undo.ts': { count: 4, why: '戻した差分を見せる文字と更新時刻。更新時刻が取れないものは「挟まっているかもしれない」として止める側（#115）。書き終えた姿のハッシュ（読めなければ比べないだけで、戻す処理は当てる側で失敗を言う）。並びの番号を振るときの読み（読めない記録は番号に数えないだけで、同じ番号なら始めた時刻で並べる）。書き終えたときの権限を残す所（読めなければ残さず、戻すときに比べない）' },
  'src/agent/prefetch.ts': { count: 3, why: 'ファイル一覧と錠の在る無しの下調べ。読めないものは一覧に載らないだけ（動かし方は別に厳しく読む、#116）' },
  'src/agent/initiative.ts': { count: 3, why: '思いつきの手がかり集め。読めないものは手がかりにしない' },
  'src/ui/server.ts': { count: 3, why: 'ファイルの情報を見せる所。読めなければ見せない（書く所は readPrior で守る）。手書きで置き換える前の権限（取れなければ新しいファイルの既定の権限になるだけ）。外を指すリンク越しかを見る所（辿れなければ、無いと言う。中身は読まない）' },
  'src/ui/attachments.ts': { count: 3, why: '添付の古い分の片づけの候補探し（読めないものは消さない）と、画像の読み出し（読めなければ渡さない。保存先は文で伝える）' },
  'src/runtime/inproc.ts': { count: 3, why: 'モデルの一覧と大きさを見るだけ。取れなければ一覧に出さない・大きさを言わない' },
  'src/core/file-lock.ts': { count: 1, why: '錠の古さ。取れなければ消さずに待つ（消す側へは倒さない）' },
  'src/core/version.ts': { count: 2, why: '版の表示。読めなければ次の候補（一つ上の VERSION・git）を出す。消す・書くことは無い' },
  'src/core/logfile.ts': { count: 2, why: '記録の大きさ（回すかどうか）と末尾の表示。読めなくても書き直さない' },
  'src/core/conversations.ts': { count: 2, why: '立ち上げたときの捨て場の片づけ。読めなければ次に立ち上げたときにまた消す（在る無しの判定は厳しく読む）。一覧を使った順に並べる時刻。取れなければ後ろに並ぶだけ（消す・書くことは無い）' },
  'src/cli/doctor.ts': { count: 1, why: '診断の表示。入っているかの下調べで、見られなければ入っていない側の案内が出るだけ' },
  'src/agent/commands.ts': { count: 2, why: '利用者が置いたコマンドの定義を読む。読めないものは一覧に出さない' },
  'src/ui/settings.ts': { count: 1, why: '保存先のフォルダの状態を見せるだけ' },
  'src/agent/outside-changes.ts': { count: 1, why: '読めなければ記録できなかった道にする（「無い」とは読まない）' },
};

// `[] as string[]` のような型の付け足しも同じ形として数える。`.then(() => true, () => false)` の二つ目の受け手も同じ
// （一つ目の受け手は読点を含まず、括弧は引数の無い呼び出し `s.isFile()` だけの短い形に限る。`(t) => g(t, () => null)` の入れ子を
// 二つ目と取り違えない。`s.isFile()` を数えずにいたので、同じ書き方の preview.ts の一か所が一覧から抜けて見えた）
const LENIENT = /\b(readFile|stat|lstat|readdir|open)\([^)]*\)[^;]*(\.catch\(|\.then\(\([^()]*\) => (?:[^(),;]|\(\))*, )\(\) => (undefined|\[\]|''|0|false|null|\{\}|Buffer\.alloc\(0\))( as [\w<>[\]]+)?\)/g;

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
