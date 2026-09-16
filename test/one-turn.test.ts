/**
 * 送って、返るところまでを、一つの部品で見る。
 *
 * ここが無いと「保存先に GGUF が在る」で終わってしまい、いちばん知りたいこと
 * （**この機械で、このモデルで、本当に答えるか**）を、使う人へ訊きに行くことになる。
 * `selftest` と `scripts/real-model.mjs` の両方がこの部品を呼ぶ。
 *
 * 本物のモデルを読む道は `scripts/real-model.mjs` が通す（node-llama-cpp が
 * 要るので、入っていない場所では飛ぶ）。ここは**どこでも同じ結果になる形**で、
 * 送る・返る・返らない・数え方・人に見せる一行を見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-oneturn-');
const { askOnce, describeOneTurn } = await import('../src/cli/ask-once.ts');

/** 送り先だけを立てた設定。この中で読む道は使わない（どこでも同じ結果にする）。 */
function configFor(baseUrl: string) {
  return {
    providers: [{
      id: 'local', kind: 'openai-compatible', baseUrl, locality: 'local', models: ['m'], enabled: true,
    }],
    candidates: ['local:m'],
    runtime: { kind: 'none' },
    initiative: { enabled: false },
  } as never;
}

describe('送って、返る', () => {
  test('**返ってきた文字と、答えたモデルを持ち帰る**', async () => {
    const fake = await startFakeServer({ kind: 'stream', text: '2 です。' });
    try {
      const got = await askOnce(configFor(fake.baseUrl), { waitMs: 30_000 });
      assert.equal(got.answer, '2 です。', `返ってきていない: ${JSON.stringify(got)}`);
      assert.equal(got.model, 'local:m');
      assert.ok(got.why === undefined, `理由が付いている: ${got.why}`);
      // 訊いた言葉も見る（別のものを送っていたら、確かめたことにならない）。
      const sent = JSON.stringify(fake.bodies);
      assert.ok(sent.includes('1+1='), `1+1= を送っていない: ${sent.slice(0, 200)}`);
    } finally { await fake.close(); }
  });

  test('人に見せる一行に、答えとモデルと読み込みが入る', async () => {
    const fake = await startFakeServer({ kind: 'stream', text: '2 です。' });
    try {
      const said = describeOneTurn(await askOnce(configFor(fake.baseUrl), { waitMs: 30_000 }));
      assert.equal(said.ok, true);
      assert.match(said.detail, /local:m/);
      assert.match(said.detail, /読み込み/);
      assert.match(said.detail, /答え「2 です。」/);
      assert.match(said.detail, /2 を含む/);
    } finally { await fake.close(); }
  });

  test('**答えが合っていなくても、道が通ったことは通ったと言う**', () => {
    // 小さいモデルは平気で間違える。道の良し悪しと、中身を分ける。
    const said = describeOneTurn({
      answer: 'いろはにほへと', model: 'local:m', loadSeconds: 1.2, answerSeconds: 0.3,
    });
    assert.equal(said.ok, true, '返っているのに NG にしている');
    assert.match(said.detail, /2 を含まない（モデルの出来。道は通っています）/);
  });

  test('**返らなかったら、返らなかったと言う**', async () => {
    // 断る相手（500）。何度やり直しても返らない。
    const fake = await startFakeServer({ kind: 'status', status: 500 });
    try {
      const got = await askOnce(configFor(fake.baseUrl), { waitMs: 8000 });
      assert.equal(got.answer, '', `答えていないのに文字が在る: ${got.answer}`);
      const said = describeOneTurn(got);
      assert.equal(said.ok, false, '返っていないのに ok にしている');
      assert.match(said.detail, /答えが返りませんでした/);
    } finally { await fake.close(); }
  });

  test('**送る先が決まらないときは、その理由を言う**', async () => {
    const got = await askOnce({
      providers: [], candidates: [], runtime: { kind: 'none' }, initiative: { enabled: false },
    } as never, { waitMs: 8000 });
    assert.equal(got.answer, '');
    assert.ok((got.why ?? '').length > 0, '理由が空');
    assert.equal(describeOneTurn(got).ok, false);
  });

  test('速さは、測れたときだけ出す（でたらめな数字を出さない）', () => {
    const many = describeOneTurn({
      answer: 'あ'.repeat(300), model: 'local:m', loadSeconds: 1, answerSeconds: 10, tps: 10,
    });
    assert.match(many.detail, /10 tok\/s/);
    const few = describeOneTurn({
      answer: '2', model: 'local:m', loadSeconds: 1, answerSeconds: 0.2,
    });
    assert.ok(!/tok\/s/.test(few.detail), `短い回で速さを出している: ${few.detail}`);
  });
});
