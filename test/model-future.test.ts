/**
 * 世代が変わっても、置いていかれない。
 *
 * ベースモデルは必ず新しくなる（Qwen3.5 → Qwen3.6 → Qwen4 …）。
 * 手で書いた表は、書いた時点で古くなり始める。**古くなること自体は
 * 止められないので、古くなったときに何が起きるかを決めておく。**
 *
 * ここで押さえるのは三つ。
 *
 *   1. 新しい世代を見に行く仕組みが、この構成でも動くこと
 *   2. 何も入っていなくても、見に行けること
 *   3. 一覧が取れなかったことを、取れたことにしないこと
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nextFamilies, findNewerFor } from '../src/runtime/model-updates.ts';
import { catalogFamilies, AVAILABLE_MODELS } from '../src/runtime/model-catalog.ts';

describe('次の世代を、必ず見に行く', () => {
  test('小数を使い切っても、次の整数を見る', () => {
    // qwen3.9 の次は qwen4。ここを埋めないと、世代が飛んだときに黙る。
    assert.ok(nextFamilies('qwen3.5').includes('qwen4'), '次の整数を見ていない');
    assert.ok(nextFamilies('qwen3.9').includes('qwen4'));
    assert.ok(nextFamilies('qwen4').includes('qwen5'));
  });

  test('**中で読む道でも、見に行く**', async () => {
    /*
     * ここは `ollama:` で始まる候補だけを見ていた。中で読む道（inproc）では
     * 候補が `inproc:Foo.gguf` の形なので、一件も当たらない。つまり
     * **この構成では、新しい世代を一度も見に行っていなかった。**
     * 作ってはあるのに、繋がっていなかった。
     */
    const asked: string[] = [];
    const fake = (async (url: string | URL) => {
      asked.push(String(url));
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    await findNewerFor({
      runtimeKind: 'inproc',
      installed: ['inproc:Qwen3.5-4B-Q4_K_M.gguf'],
      fetchImpl: fake,
    });
    assert.ok(asked.length > 0, '一度も訊きに行っていない');
    assert.ok(asked.some((u) => u.includes('qwen4')), `次の整数を訊いていない: ${asked.join(' ')}`);
  });

  test('Ollama のときは、Ollama の配布元へ訊く（対）', async () => {
    const asked: string[] = [];
    const fake = (async (url: string | URL) => {
      asked.push(String(url));
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    await findNewerFor({ runtimeKind: 'ollama', installed: ['ollama:qwen3.5:9b'], fetchImpl: fake });
    assert.ok(asked.every((u) => u.includes('ollama')), `訊く先が違う: ${asked.join(' ')}`);
  });

  test('**何も入っていなくても、見に行く**', async () => {
    // 入れた直後は一つも入っていない。そこで黙ると、最初の一つが
    // 手で書いた表のまま固定される。
    const asked: string[] = [];
    const fake = (async (url: string | URL) => {
      asked.push(String(url));
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    await findNewerFor({
      runtimeKind: 'inproc', installed: [], seed: catalogFamilies(), fetchImpl: fake,
    });
    assert.ok(asked.length > 0, '何も入っていないと、黙って諦めている');
  });

  test('手がかりが無ければ、当てずっぽうに訊かない（対）', async () => {
    let asked = 0;
    const fake = (async () => { asked += 1; return new Response('[]', { status: 200 }); }) as unknown as typeof fetch;
    await findNewerFor({ runtimeKind: 'inproc', installed: [], fetchImpl: fake });
    assert.equal(asked, 0, '手がかりが無いのに訊きに行っている');
  });

  test('カタログの家族が取り出せる', () => {
    const families = catalogFamilies();
    assert.ok(families.length > 0, 'カタログから家族が取れない');
    // 大きさの札（`:9b`）は家族ではない。付いたままだと配布元に当たらない。
    assert.ok(families.every((f) => !f.includes(':')), `札が付いたまま: ${families.join(', ')}`);
    assert.ok(families.every((f) => nextFamilies(f).length > 0),
      `次の世代を組み立てられない名前がある: ${families.join(', ')}`);
  });

  test('カタログの名前は、世代の形をしている', () => {
    // 形が崩れると、次の世代を組み立てられない＝古いまま固定される。
    for (const m of AVAILABLE_MODELS) {
      assert.match(m.ollama, /^[a-z][a-z0-9-]*\d+(\.\d+)?:/,
        `世代が読めない名前: ${m.ollama}`);
    }
  });
});

describe('一覧が取れなかったことを、取れたことにしない', () => {
  /**
   * 既定の設定には、その時点のモデル名が書いてある。一覧が取れないとき、
   * ここは**その名前をそのまま「在るもの」として返していた。**
   * 画面には存在しないモデルが候補として並び、送るたびに叩いていた。
   * しかも書いてある名前は世代ごと古くなるので、**放っておくと必ずそうなる。**
   */
  test('**繋がらないときの名前には、確かめていない印が付く**', async () => {
    const { OpenAiCompatibleProvider } = await import('../src/providers/openai-compatible.ts');
    const p = new OpenAiCompatibleProvider({
      id: 'local',
      // 誰も居ない口。一覧は取れない。
      baseUrl: 'http://127.0.0.1:1/v1',
      locality: 'local',
      fallbackModels: ['qwen3.6:35b-a3b-coding-nvfp4'],
    });
    const models = await p.listModels();
    assert.equal(models.length, 1, '控えを返していない');
    assert.equal(models[0]!.verified, false, '確かめていないのに、確かめた印になっている');
  });

  test('相手が答えたものには、確かめた印が付く（対）', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'ほんとうに在るモデル' }] }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    try {
      const { OpenAiCompatibleProvider } = await import('../src/providers/openai-compatible.ts');
      const p = new OpenAiCompatibleProvider({
        id: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local',
        fallbackModels: ['書いてあるだけの名前'],
      });
      const models = await p.listModels();
      assert.deepEqual(models.map((m) => m.model), ['ほんとうに在るモデル']);
      assert.equal(models[0]!.verified, true);
    } finally {
      await new Promise<void>((done) => { server.close(() => done()); });
    }
  });

  test('**確かめていない名前で進むときは、そう言う**', async () => {
    const { setupAutopilot, resolveCandidates } = await import('../src/core/autopilot-setup.ts');
    const { buildRegistry } = await import('../src/core/build.ts');
    const config = {
      providers: [{
        id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1',
        locality: 'local', models: ['qwen3.5:9b'], enabled: true,
      }],
      runtime: { kind: 'ollama' },
    } as never;
    const bundle = await setupAutopilot(config, buildRegistry(config));
    const { candidates, note } = resolveCandidates(config, bundle);
    assert.ok(candidates.length > 0, '控えで進めていない');
    assert.match(note, /確かめていません/,
      `確かめていないのに、そう言っていない: ${note}`);
  });
});
