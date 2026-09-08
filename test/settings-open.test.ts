/**
 * 設定は、**中身が返る前に出す。**
 *
 * 読み終えてから出していたので、一つでも返ってこないと、設定は出るのに
 * 中身が全部空になった（動かし方の一覧まで空で、何も選べない）。
 * しかも順に待つので、前のものが返らなければ後のものは読みに行きもしない。
 *
 * 走らせて出すには、返ってこない口を作らないと再現できない。ここは書き方で止める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(root, 'src/ui/web/app.js'), 'utf8');

test('openSettings は、読み終える前に画面を出す', () => {
  const body = app.slice(app.indexOf('async function openSettings'));
  const fn = body.slice(0, body.indexOf('\n}\n') + 1);
  assert.ok(fn.includes('showModal'), 'openSettings が設定を出していない');
  const show = fn.indexOf('showModal');
  const waits = [...fn.matchAll(/await\s+load\w+\(/g)].map((m) => m.index ?? 0);
  for (const at of waits) {
    assert.ok(at > show, `出す前に読み終えるのを待っている: ${fn.slice(at, at + 40)}`);
  }
});

test('モデルの頁は、二つの読み込みを直列に待たない', () => {
  // `await loadCfg(); await loadCatalog();` だと、前が返らない限り
  // 「取ってくる先」は空のままになる。
  assert.ok(!/await\s+loadCfg\(\);\s*await\s+loadCatalog\(\)/.test(app),
    'loadCfg を待ってから loadCatalog を読んでいる');
});

/**
 * 読み込みの進み具合を、いつも見える所に出す。
 *
 * 進み具合（10% ごと）は前から出していた。出す先が「流れ」だけだったので、
 * **そこを開いていない人には、何も出ていないのと同じ。**数GBを読む間ずっと
 * 「待機中」と出ていて、送ったのに無視されたようにしか見えなかった。
 */
test('読み込み中の行を、上の帯へ出す', () => {
  const src = readFileSync(join(root, 'src/ui/web/app.js'), 'utf8');
  // 出来事を受け取る所で、読み込みの行を拾って帯へ渡していること。
  assert.ok(src.includes('まだ読み込んでいます'), '読み込みの行を拾っていない');
  const at = src.indexOf('まだ読み込んでいます');
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 200), /run\.set\('busy'/, '帯へ渡していない');
});
