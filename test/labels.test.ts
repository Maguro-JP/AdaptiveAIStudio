/**
 * **選び場の札に、別のものの名前を付けない。**
 *
 * 設定 → 見た目 のテーマを選ぶ所に、札として「ランタイム」と書いてあった。
 * この言葉は、この画面では**モデルの動かし方**の名前として使っている
 * （情報の行と、モデルのパネルの見出し）。開いた人は、動かし方を変える所だと
 * 思って触る。見た目が変わって、探していたものは見つからない。
 *
 * 札は画面（index.html）に、選択肢は本体の返し（`/api/theme`・`/api/layout`）に
 * 在るので、片方だけ直しても食い違ったままになる。ここで留める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'src/ui/web/index.html'), 'utf8');

/** 選び場（select）の id と、その前に置く札。 */
const LABELS: Record<string, string> = {
  // `/api/theme` が返す themes を並べる所。
  themes: 'テーマ',
  // `/api/layout` が返す presets を並べる所。
  presets: 'プリセット',
  // モデルの動かし方（inproc / ollama / llamacpp）を選ぶ所。
  cfgKind: '動かし方',
};

/**
 * **ほかのものの名前として使っている言葉。**上の三つの札に使わない。
 *
 * 「ランタイム」は情報の行（`app.js` の名前の表）とモデルのパネルの見出しで、
 * モデルの動かし方を指している。同じ言葉を別のものに付けると、案内が効かない。
 */
const TAKEN = ['ランタイム', 'いまのモデル'];

for (const [id, want] of Object.entries(LABELS)) {
  test(`${id} の札は「${want}」`, () => {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > 0, `${id} が画面に無い`);
    // 直前の <span class="dim">…</span> を取る（札はいつもこの形で置いている）。
    const before = html.slice(0, at);
    const m = [...before.matchAll(/<span class="dim">([^<]*)<\/span>/g)].pop();
    assert.ok(m, `${id} の前に札が無い`);
    assert.equal(m![1], want, `${id} の札が「${m![1]}」になっている`);
    assert.ok(!TAKEN.includes(m![1]!) || m![1] === want,
      `${id} の札に、ほかのものの名前を付けている: ${m![1]}`);
  });
}
