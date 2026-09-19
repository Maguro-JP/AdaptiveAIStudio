/**
 * いま開いている所が、AI に渡るか。
 *
 * **渡っていなかった。**人は画面を見ながら「この関数を直して」と打つので、
 * 指せているつもりになる。AI には何も届いていないので、当てずっぽうで探すか
 * 訊き返すしかない。エディタを作っても、そこが繋がっていなければ使えない。
 *
 * ここで見るのは三つ。画面から来たものを形だけで受け取ること（よその道を弾く）、
 * 人が読める一塊になること、長い選択を切って**切ったと書く**こと。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { editorHere, describeEditorHere } from '../src/ui/editor-here.ts';

describe('いま開いている所', () => {
  test('名前・行・選んでいる所を受け取る', () => {
    const got = editorHere({ path: 'src/a.ts', line: 12, selection: 'const x = 1;', selectionFrom: 12, selectionTo: 12 });
    assert.deepEqual(got, {
      path: 'src/a.ts', line: 12, selection: 'const x = 1;', selectionFrom: 12, selectionTo: 12,
    });
  });

  test('**よその道は受け取らない**', () => {
    // 画面から来たものを、そのまま信じない。絶対の道と `..` は断る。
    for (const path of ['/etc/passwd', 'C:\\Windows\\system.ini', '../../secret', 'a/../../b', '', '   ']) {
      assert.equal(editorHere({ path }), undefined, `受け取ってはいけない道を受け取った: ${path}`);
    }
    // 形が違うものも、落ちずに undefined。
    for (const raw of [undefined, null, 'src/a.ts', 42, {}, { path: 5 }]) {
      assert.equal(editorHere(raw), undefined, `形が違うのに受け取った: ${JSON.stringify(raw)}`);
    }
  });

  test('でたらめな行や選択の範囲は、落として通す', () => {
    // 依頼そのものは通す。渡らないのは、開いている所だけ。
    const got = editorHere({ path: 'a.ts', line: -3, selection: '', selectionFrom: 0, selectionTo: 1.5 });
    assert.deepEqual(got, { path: 'a.ts' });
  });

  test('人が読める一塊になる（選んでいなければ名前と行だけ）', () => {
    assert.equal(describeEditorHere({ path: 'src/a.ts', line: 3 }), '【いま開いているファイル】src/a.ts（3 行目）');
    assert.equal(describeEditorHere(undefined), '');
    assert.match(describeEditorHere({ path: 'a.ts', line: 1, dirty: true }), /保存していない直しがあります/);
  });

  test('選んでいる所は、行の範囲つきで囲んで渡す', () => {
    const said = describeEditorHere({
      path: 'src/a.ts', line: 10, selection: 'function f() {\n  return 1;\n}', selectionFrom: 10, selectionTo: 12,
    });
    assert.match(said, /【選んでいる所】10〜12 行目/);
    assert.match(said, /function f\(\) \{/);
    assert.match(said, /```/);
  });

  test('**長い選択は切って、切ったと書く**', () => {
    // 黙って切ると、AI は全部を見たつもりで答える。
    const said = describeEditorHere({ path: 'a.ts', selection: 'あ'.repeat(5000) }, 100);
    assert.ok(said.length < 400, `切っていない: ${said.length} 文字`);
    assert.match(said, /ここで切りました/);
    assert.match(said, /read_file/, '続きの読み方を書いていない');
  });
});
