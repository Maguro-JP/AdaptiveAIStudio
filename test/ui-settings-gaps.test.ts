/**
 * 画面の設定・見た目・添付の不具合（48 回目の調査）。
 *
 * - 既定の保存先を、絶対の道として設定に焼き込んでいた（portable のフォルダを移すと、古い場所を指したまま）
 * - 引用符で囲んで貼った道を、引用符ごと保存していた
 * - 自分で作った見た目の元を残さず、開くたびに「知らない見た目」と直した知らせを出していた
 * - 添付を何件か付けると、後ろの添付が中身の無い塊で渡り、「入れていません」とも言わなかった
 * - 文字の拡張子なら中身を見ず、二進のファイルを依頼に差し込んでいた
 *
 * 送りが断られたときに添付を受け皿へ戻すのは画面の JS（`panels.js`）の直しで、ここでは試験を書いていない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { sameDir, unquotePath, saveRuntime } from '../src/ui/settings.ts';
import { repairTheme } from '../src/ui/theme.ts';
import { Attachments, detectKind } from '../src/ui/attachments.ts';

describe('保存先', () => {
  test('**既定の保存先と同じ道は、設定に書かない**', async () => {
    const dir = await tempDir('aas-ui-settings-cfg-');
    const models = join(dir, 'models');
    const before = { config: process.env.AAS_CONFIG, models: process.env.AAS_MODELS_DIR };
    process.env.AAS_CONFIG = join(dir, 'aas.config.json');
    process.env.AAS_MODELS_DIR = models;
    try {
      await saveRuntime('inproc', `${models}/`);
      const saved = JSON.parse(await readFile(process.env.AAS_CONFIG, 'utf8')) as { runtime: Record<string, unknown> };
      assert.equal(saved.runtime.modelsDir, undefined, `既定の道を焼き込んだ: ${JSON.stringify(saved.runtime)}`);
      await saveRuntime('inproc', join(dir, 'elsewhere'));
      const again = JSON.parse(await readFile(process.env.AAS_CONFIG, 'utf8')) as { runtime: Record<string, unknown> };
      assert.equal(again.runtime.modelsDir, join(dir, 'elsewhere'), '既定と違う道は書く');
    } finally {
      if (before.config === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = before.config;
      if (before.models === undefined) delete process.env.AAS_MODELS_DIR; else process.env.AAS_MODELS_DIR = before.models;
    }
  });

  test('同じ場所かは、末尾の区切りと（Windows では）大小を見ない', () => {
    assert.equal(sameDir('/a/b/', '/a/b', 'linux'), true);
    assert.equal(sameDir('/a/B', '/a/b', 'linux'), false);
    assert.equal(sameDir('/A/B', '/a/b', 'win32'), true);
  });
});

describe('貼った道', () => {
  test('**前後の引用符を外す**（Windows の「パスのコピー」の形）', () => {
    assert.equal(unquotePath('"C:\\Users\\me\\proj"'), 'C:\\Users\\me\\proj');
    assert.equal(unquotePath("  'D:\\models'  "), 'D:\\models');
    assert.equal(unquotePath('C:\\Users\\me'), 'C:\\Users\\me');
    assert.equal(unquotePath('"half'), '"half', '片側だけの引用符は外さない');
  });
});

describe('自分で作った見た目', () => {
  test('**保存したものを読み直しても、知らない見た目と言わない**', () => {
    const first = repairTheme({ base: 'slate', id: 'custom', name: '自分の色', tokens: {} });
    assert.deepEqual(first.repairs, []);
    assert.ok(first.theme.base, '元の見た目を残していない');
    // 保存されたもの（theme）を、そのまま読み直す
    const again = repairTheme(JSON.parse(JSON.stringify(first.theme)));
    assert.deepEqual(again.repairs, [], `開くたびに直した知らせを出す: ${JSON.stringify(again.repairs)}`);
  });
});

describe('添付', () => {
  test('**中身が入らない添付は、入れなかったと言う**（中身の無い塊を渡さない）', async () => {
    const dir = await tempDir('aas-ui-settings-attach-');
    const att = new Attachments(dir);
    // 1 件目と 2 件目で、コンテキストウィンドウの残りが囲みの分より少なく、まだ上限には届いていない形（直す前の版で、3 件目が中身の無い塊になった大きさ）
    const ids = [
      (await att.add('a.txt', Buffer.from('x'.repeat(1876)))).id,
      (await att.add('b.txt', Buffer.from('y'.repeat(4000)))).id,
      (await att.add('c.txt', Buffer.from('z'.repeat(1000)))).id,
    ];
    const out = await att.describe(ids, { chars: { each: 3000, total: 5000 } });
    assert.doesNotMatch(out, /--- 添付: c\.txt ---\n\n?…/, `中身の無い塊を入れた:\n${out.slice(-300)}`);
    assert.match(out, /入れていません/, '入らなかったことを言っていない');
  });

  test('**文字の拡張子でも、中身が二進なら文字ものにしない**', () => {
    const video = Buffer.from([0x47, 0x40, 0x00, 0x10, 0x00, 0x00, 0xb0, 0x0d]);
    assert.equal(detectKind('rec.ts', video), 'binary');
    assert.equal(detectKind('app.ts', Buffer.from('export const a = 1;\n')), 'text');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ab', 'utf16le')]);
    assert.equal(detectKind('note.txt', utf16), 'text', 'UTF-16 を二進にした');
  });
});
