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
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-oneturn-');
const { askOnce, describeOneTurn, judgeAnswer, describeEnd } = await import('../src/cli/ask-once.ts');

/**
 * 読む側のモック。数GBの GGUF を置かずに、読む道だけ通す。
 *
 * 機械の素性も返す。**毎回同じ値**にしてあるので、走らせる機械が
 * 変わっても同じ一行になる（本物の CPU を見に行かせない）。
 */
const fakeLib = async () => ({
  getLlama: async () => ({
    systemInfo: 'CPU : SSE3 = 1 | AVX2 = 1 | AVX512 = 0 | FMA = 1',
    cpuMathCores: 4,
    maxThreads: 8,
    loadModel: async () => ({
      createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
    }),
  }),
  LlamaChatSession: class { setChatHistory() {} async prompt() { return '2'; } },
});

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
      assert.match(said.detail, /2 と答えています/);
    } finally { await fake.close(); }
  });

  test('**答えが合っていなくても、道が通ったことは通ったと言う**', () => {
    // 小さいモデルは平気で間違える。道の良し悪しと、中身を分ける。
    const said = describeOneTurn({
      answer: 'いろはにほへと', model: 'local:m', loadSeconds: 1.2, answerSeconds: 0.3,
    });
    assert.equal(said.ok, true, '返っているのに NG にしている');
    assert.match(said.detail, /2 と答えていません（.+。モデルの出来。道は通っています）/);
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

  test('**2 と答えたか、は本物の文字で見る（乱数の模型が偶然 2 を含んでも通さない）**', () => {
    // 通る形。答えそのもの・問いの写し・文の中・考えごとの後ろ。
    for (const ok of ['2', '1+1=2', '1 + 1 = 2', '答えは 2 です。', '<think>足す</think>\n2', '2\n',
      // 別の役割の読み直しで、前の判定（最初の数字が 2）が落としていた形。
      '1 plus 1 equals 2', 'The sum of 1 and 1 is 2.', '２', 'The answer to your question is 2.', '1+1等于2']) {
      assert.equal(judgeAnswer(ok), undefined, `通るはずの「${ok}」を落とした: ${judgeAnswer(ok)}`);
    }
    // 落ちる形。乱数の模型が実際に返したもの（2 を含む）・壊れた文字・違う数・空・数字なし。
    const garbage = 'Фt2\uFFFDY\uFFFDg\uFFFD\u0DE0#\uFFFD\uFFFD\uFFFD \uFFFD\uFFFD\u061Cr%\uFFFDP\uFFFD\uFFFDt2';
    for (const ng of [garbage, 'Фt2Y', '22', '2.5', '3', '', '   ', '<think>2</think>', 'いろはにほへと', '1+1=3',
      // 前の判定が通していた形（2 が先に来るが、答えは別）。
      '2 is wrong; the answer is 3', '2 + 2 = 4', '2. Wait, no, 3.', '12']) {
      assert.notEqual(judgeAnswer(ng), undefined, `落ちるはずの「${ng}」を通した`);
    }
    // 人が読む一行にも、2 と答えたかどうかが出る。
    const said = describeOneTurn({ answer: garbage, model: 'local:m', loadSeconds: 1, answerSeconds: 0.3 });
    assert.equal(said.ok, true, '返っているのに NG にしている');
    assert.match(said.detail, /2 と答えていません（壊れた文字/);
    assert.match(describeOneTurn({ answer: '2', model: 'local:m', loadSeconds: 1, answerSeconds: 0.3 }).detail, /2 と答えています/);
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

describe('読む側の声も、頼んだ人まで届く', () => {
  /**
   * **ここを渡していなかったので、遅い理由が記録に出なかった。**
   *
   * Windows の一回が ubuntu の 10 倍かかったとき、記録に在ったのは
   * 「停滞」だけだった。backend も CPU の素性も tok/s も、読む側
   * （InProcRuntime）が持っていて、`log` を渡した相手にしか言わない。
   *
   * **「渡す行が在る」ことでは確かめない。**行を消しても案内は残るので、
   * 実際に読ませて、読む側の一行が届くところを見る。
   */
  test('askOnce に log を渡すと、backend の一行が届く', async () => {
    const dir = await tempDir('aas-oneturn-log-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const said: string[] = [];
    // 候補を書かない。書くと読む側に触らずに終わる（`readyLocalModel` が即座に返す）。
    // 返事そのものは見ない（送り先は立てていない）。**見るのは記録の側**。
    await askOnce({
      providers: [{
        id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1',
        locality: 'local', models: ['m.gguf'], enabled: true,
      }],
      runtime: { kind: 'inproc', modelsDir: dir, basePort: 0 },
      initiative: { enabled: false },
    } as never, {
      waitMs: 5000,
      log: (l) => { said.push(l); },
      hooks: { inprocLoad: fakeLib },
    });
    const line = said.find((l) => /で読みます/.test(l));
    assert.ok(line, `読む側の一行が届いていない: ${JSON.stringify(said)}`);
    // 素性とコアの数まで届く。ここが無いと「なぜ遅いのか」が記録から読めない。
    assert.match(line, /AVX2/, `素性が入っていない: ${line}`);
    assert.match(line, /4 コア \/ 8 スレッド/, `機械の大きさが入っていない: ${line}`);
  });
});

describe('上限で切ったのか、モデルが黙ったのか', () => {
  /*
   * **直し方が正反対になる。**モデルが黙ったのなら訊き方や重みの話だが、
   * こちらが待ち切れなかったのなら出す量の話（上限は伸ばさない）。
   * Windows の回で、上限で切られたものを「モデルが黙った」と読んだ。
   */
  test('上限で切ったら、切ったと言う（秒・文字・呼び出しの回数まで）', () => {
    const said = describeEnd({
      aborted: true, limitMs: 600_000, tookMs: 616_000, chars: 1, calls: 0,
      // 切られた回でも、途中の終わり方が付いていることがある。上限の方を言う。
      reason: 'noProgress', detail: '返事が空でした',
    });
    assert.match(said, /10分で打ち切りました/, said);
    assert.match(said, /616秒/, said);
    assert.match(said, /1文字/, said);
    assert.match(said, /ツールの呼び出し 0 回/, said);
    assert.ok(!/noProgress/.test(said), `モデルが黙ったように読める: ${said}`);
  });

  test('1分に満たない上限は、秒で言う', () => {
    assert.match(
      describeEnd({ aborted: true, limitMs: 30_000, tookMs: 30_100, chars: 0, calls: 0 }),
      /30秒で打ち切りました/,
    );
  });

  test('切っていないなら、終わり方をそのまま言う', () => {
    const said = describeEnd({
      aborted: false, limitMs: 600_000, tookMs: 12_000, chars: 40, calls: 1,
      reason: 'noProgress', detail: '返事が空でした',
    });
    assert.equal(said, '終わり方: noProgress 返事が空でした');
    // 理由が付いていなくても、打ち切りと読ませない。
    assert.equal(
      describeEnd({ aborted: false, limitMs: 600_000, tookMs: 1, chars: 0, calls: 0 }),
      '終わり方: 不明',
    );
  });
});
