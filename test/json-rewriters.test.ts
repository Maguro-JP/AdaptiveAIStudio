/**
 * JSON を読んで書き戻すファイルを、新しく足すときに同じ不具合を持ち込ませない。
 *
 * 覚えておくファイル（記憶・やり残し・提案・当番・暇・歩幅・役職・画面の並び・設定）は、読めない・壊れている・一件だけ形が違う
 * ときに、空で上書きする・止まる・全部捨てる、を一つずつ直した（2026-09-26〜27、#63〜#83）。読む・書くは `src/core/journal-file.ts`
 * にまとめた。それでも新しく書く所は、また `try { JSON.parse } catch { 空 }` から始めがちで、同じ不具合を持ち込む。
 *
 * ここでは、JSON を読み（`JSON.parse`）、JSON を書き（`JSON.stringify` と書き込み）するファイルを数える。`journal-file` を通すか、
 * 下の一覧に「なぜ自分で持っているか」を書くまで落とす。一覧に書くのは、読めないときと形の違う一件の扱いを確かめた後。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const root = join(import.meta.dirname, '..');

/** 自分で読み書きを持っているファイルと、その理由（どこで確かめたか）。 */
const OWN_HANDLING: Record<string, string> = {
  'src/agent/code-index.ts': '作り直せる索引。読めなければ作り直す（利用者のデータではない。書くのは一時ファイルを通さないが、壊れても作り直す）',
  'src/agent/proposals.ts': '一件の null で止まらない・読めないときは書かない・保存の直前に合わせる（#73、test/proposals-safety.test.ts）',
  'src/core/conversations.ts': '追記式。壊れた行は飛ばす。消すときは trash へ移す（#63・#91）',
  'src/core/goals.ts': '追記式。壊れた行・形の違う行は飛ばす。畳むときは一度だけ読み、別の版の行は残す（#65・#69、test/goals-safety.test.ts・test/compact-read-once.test.ts）',
  'src/core/undo.ts': '戻り先。別の作業場の分に当たらない・読めないときに空で上書きしない（#64、test/state-safety.test.ts）',
  'src/core/unfinished.ts': '追記式。壊れた行・形の違う行は飛ばす。畳むときは一度だけ読み、別の版の行は残す。読めないときの戻すは投げる（#64・#90、test/compact-read-once.test.ts）',
  'src/memory/memory.ts': '読み飛ばした行を数えて残し、読めないときに上書きしない（#64・#72）',
  'src/runtime/machine.ts': 'マシンの検出結果。null や空の入れ物なら検出し直す（作り直せる、#75）',
};

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...await sources(path));
    else if (/\.(ts|js|mjs)$/.test(e.name)) out.push(path);
  }
  return out;
}

/** 注釈の行を除いた中身。注釈に書いた `JSON.parse` で数えない。 */
const code = (text: string): string => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** JSON を読んで、JSON をファイルへ書くか。 */
export function rewritesJson(text: string): boolean {
  const c = code(text);
  return /JSON\.parse\(/.test(c) && /JSON\.stringify\(/.test(c) && /\b(writeFile|appendFile|rename)\(/.test(c);
}

/** journal-file を通しているか。読む側（`readJournal`・`loadJournal`）を使っていること。書く側（`writeWhole`）だけでは、読む側が
 * `catch { 空 }` のままでも通ってしまう。 */
const usesJournal = (text: string): boolean => /\b(readJournal|loadJournal)\(/.test(code(text));

test('**JSON を読んで書き戻すファイルは、journal-file を通すか、自分で持つ理由が一覧に在る**', async () => {
  const found: string[] = [];
  for (const path of await sources(join(root, 'src'))) {
    const text = await readFile(path, 'utf8');
    if (!rewritesJson(text)) continue;
    const name = relative(root, path).split(sep).join('/');
    found.push(name);
  }
  assert.ok(found.length >= 5, `見つけられていない（${found.length} 件）。書き方が変わったなら、この試験も合わせる`);
  const unknown = [];
  for (const name of found) {
    if (OWN_HANDLING[name]) continue;
    if (usesJournal(await readFile(join(root, name), 'utf8'))) continue;
    unknown.push(name);
  }
  assert.deepEqual(unknown, [],
    `JSON を読んで書き戻すのに、journal-file の読む側（readJournal / loadJournal）を通していません:\n${unknown.join('\n')}\n`
    + '読めない・壊れている・一件だけ形が違うときに空で上書きしないことを確かめたうえで、通すか、この試験の一覧に理由を書く');
  // 一覧に残っているのに、もう当たらないもの（直して journal-file へ寄せた・消した）は一覧から外す
  const stale = Object.keys(OWN_HANDLING).filter((name) => !found.includes(name));
  assert.deepEqual(stale, [], `一覧に在るのに、もう JSON を読んで書き戻していません。一覧から外す:\n${stale.join('\n')}`);
});

test('数え方: 読むだけ・書くだけ・注釈の中だけのものは数えない（対）', () => {
  assert.equal(rewritesJson("const a = JSON.parse(await readFile(p, 'utf8'));\nawait writeFile(p, JSON.stringify(a));"), true);
  assert.equal(rewritesJson("const a = JSON.parse(text);"), false);
  assert.equal(rewritesJson("await writeFile(p, JSON.stringify(a));"), false);
  assert.equal(rewritesJson("// JSON.parse(x) を使う\nawait writeFile(p, JSON.stringify(a));"), false);
});
