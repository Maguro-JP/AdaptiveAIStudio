/**
 * 1ターンの結末に、**どのモデルがどれだけの速さだったか**を添える。
 *
 * 「完了 · 182.3秒」とだけ出ていた。8B を CPU で読んでいて一言に 3 分
 * かかっていたとき、遅い理由がどこにも無く、壊れているようにしか見えなかった。
 * 数字は metrics に溜まっていたが、設定の奥で、誰も見ない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verdictText, slowNote, howText, SLOW_TPS } from '../src/ui/web/verdict.js';
import { speedOf } from '../src/core/session.ts';

describe('結末の一行', () => {
  test('モデルと速さを、同じ行に出す', () => {
    const line = verdictText({ reason: 'completed', checked: 'notRun', seconds: 12.34, model: 'a.gguf', tps: 4.2 });
    assert.equal(line, '完了（検証していません） · 12.3秒 · a.gguf · 約 4.2 tok/s');
  });

  test('測れていない回は、速さを出さない（でたらめな数字を出さない）', () => {
    const line = verdictText({ reason: 'completed', checked: 'passed', seconds: 0.4, model: 'a.gguf' });
    assert.equal(line, '完了（検証を通りました） · 0.4秒 · a.gguf');
    assert.equal(slowNote({ reason: 'completed', seconds: 0.4, model: 'a.gguf' }), '');
  });

  test('遅ければ、その場で理由を言う', () => {
    const slow = slowNote({ reason: 'completed', seconds: 180, model: 'big-8b.gguf', tps: 1.1 });
    assert.match(slow, /遅い/);
    assert.match(slow, /1\.1 tok\/s/);
    assert.match(slow, /小さいモデル/);
    assert.equal(slowNote({ reason: 'completed', seconds: 10, model: 'a', tps: SLOW_TPS }), '');
  });

  /**
   * ここは「理由の語はそのまま」を正しい形として固定していた。
   * その結果、**`noProgress` が画面にそのまま出ていた**（実機の画面で見た）。
   * 打った人に符丁を見せない、が決まり（CLAUDE.md「外は利用者の語」）。
   */
  test('**うまく終わらなかった回も、符丁を見せない**', () => {
    assert.equal(howText({ reason: 'noProgress' }), '進みませんでした');
    assert.equal(howText({ reason: 'maxTurns' }), '打ち切りました（往復の上限に届きました）');
    assert.equal(howText({ reason: 'aborted' }), '止めました');
    assert.equal(howText({ reason: 'failed' }), '落ちました');
    const line = verdictText({ reason: 'noProgress', seconds: 0.2, model: 'inproc:tiny.gguf' });
    assert.ok(!line.includes('noProgress'), `符丁が出ている: ${line}`);
    assert.match(line, /^進みませんでした · 0\.2秒 · inproc:tiny\.gguf$/);
  });

  test('知らない符丁でも、符丁のままは出さない。ただし隠さない（対）', () => {
    // 隠すと、送ってもらったときに何が起きたか分からなくなる。
    const said = howText({ reason: 'somethingNew' });
    assert.ok(!/^somethingNew$/.test(said), `符丁をそのまま出している: ${said}`);
    assert.match(said, /終わりました/);
    assert.match(said, /somethingNew/, '符丁を隠している（送ってもらうときに要る）');
  });

  /**
   * 「明日の天気は？」に「完了（検証していません）」と出していた（実機の画面）。
   * 何も完了していないし、確かめるものも無い。作業の言葉を、会話にも着せていた。
   */
  test('**訊かれただけの回に、作業の言葉を着せない**', () => {
    assert.equal(howText({ reason: 'completed', checked: 'notRun', chat: true }), '答えました');
    const line = verdictText({ reason: 'completed', checked: 'notRun', chat: true, seconds: 3.3, model: 'tiny.gguf' });
    assert.ok(!line.includes('完了'), `完了と言っている: ${line}`);
    assert.ok(!line.includes('検証'), `確かめる話をしている: ${line}`);
    assert.match(line, /^答えました · 3\.3秒 · tiny\.gguf$/);
  });

  test('**作業の回は、これまでどおり検証で言う（対）**', () => {
    // ここが一緒になると、確かめていない作業まで「答えました」で流れる。
    assert.equal(howText({ reason: 'completed', checked: 'notRun' }), '完了（検証していません）');
    assert.equal(howText({ reason: 'completed', checked: 'notRun', chat: false }), '完了（検証していません）');
    assert.equal(howText({ reason: 'completed', checked: 'passed' }), '完了（検証を通りました）');
  });

  test('訊かれた回でも、落ちたら落ちたと言う（対）', () => {
    // chat を見て「答えました」に倒すのは、completed の回だけ。
    assert.equal(howText({ reason: 'failed', chat: true }), '落ちました');
  });
});

describe('速さの数え方', () => {
  test('文字数から見積もり、metrics と同じ線で切る', () => {
    assert.deepEqual(speedOf('m', 300, 10), { model: 'm', outputTokens: 100, tps: 10 });
    // 一言（20 トークン未満）や 1 秒未満は数えない。非現実的な値になる。
    assert.deepEqual(speedOf('m', 30, 10), { model: 'm', outputTokens: 10 });
    assert.deepEqual(speedOf('m', 300, 0.5), { model: 'm', outputTokens: 100 });
  });
});

/**
 * 符丁が増えたときに、引き直しを足し忘れたら落とす。
 *
 * 文章で「符丁を見せない」と決めても守れなかった（`noProgress` が画面に出た）。
 * 決まりは読まれないので、**実行の手前で止める形**にする。
 * 終わり方の符丁は `src/agent/loop.ts` の `finished` の型が持っている。
 * そこに一つ足したら、ここが落ちる。
 */
describe('終わり方の符丁は、全部が人の言葉になっている', () => {
  test('**loop が返しうる符丁に、抜けが無い**', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const src = (await readFile(join(root, 'src/agent/loop.ts'), 'utf8')).replace(/\r\n/g, '\n');

    // `reason: 'completed' | 'maxTurns' | ...` の並びを取る。
    const at = src.indexOf("type: 'finished'; reason:");
    assert.notEqual(at, -1, 'loop.ts の finished の型が見つからない（形が変わった）');
    const line = src.slice(at, src.indexOf('\n', at));
    const reasons = [...line.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]!)
      .filter((r) => r !== 'finished');
    assert.ok(reasons.length >= 4, `符丁が読めていない: ${line}`);

    const missing = reasons
      .filter((r) => r !== 'completed')
      .filter((r) => {
        const said = howText({ reason: r });
        // 符丁がそのまま出ている、または「終わりました（符丁）」の逃がしに落ちている。
        return said === r || said.startsWith('終わりました（');
      });
    assert.deepEqual(missing, [],
      `人の言葉になっていない符丁がある。src/ui/web/verdict.js の WHY に足す: ${missing.join(', ')}`);
  });
});
