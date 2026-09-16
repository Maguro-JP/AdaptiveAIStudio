/**
 * 前置きが、窓を食い潰さない。
 *
 * 載せるものごとに窓の割合を別々に決めていた（学び 15%、置き場の決まり 20%、
 * 道具の説明 15%）。一つずつ見るとどれも「窓に合わせて」いる。
 * **合計を誰も見ていない。**足すと、依頼と履歴の前に窓の半分が消える。
 * 窓 4096 のモデルでは 56%（実測）。
 *
 * 狭い窓ほど効く。**そこが、この道具がいちばん使われる場所。**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';
import { Session, SYSTEM_SHARE } from '../src/core/session.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { estimateTokens } from '../src/agent/window.ts';

/** 前置きに載るものを、わざと多くした置き場。 */
async function crowded(): Promise<string> {
  const root = await tempDir('aas-sysbudget-');
  // 長い置き場の決まり。丸ごと載れば、それだけで窓が埋まる。
  await writeFile(join(root, 'AGENTS.md'), Array.from(
    { length: 400 }, (_, i) => `- 決まり${i}: この置き場ではこう書きます。長めに書いておきます。`,
  ).join('\n'));
  return root;
}

async function systemAt(window: number, root: string): Promise<string> {
  const fake = await startFakeServer({ kind: 'stream', text: 'はい' });
  try {
    const session = await Session.create({
      ...DEFAULT_CONFIG,
      providers: [{
        id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl,
        locality: 'local', models: ['m'],
      }],
      candidates: ['local:m'],
      runtime: { contextSize: window },
      agent: { root, approval: 'auto' },
      initiative: { enabled: false },
    } as never, { approve: () => Promise.resolve(true) });
    // 学びを積む。**いちばん載せたいものが、いちばん先に取る。**
    session.memory.seedLessons();
    return await session.systemPrompt();
  } finally { await fake.close(); }
}

describe('前置きは、窓の決めた割合に収まる', () => {
  for (const window of [2048, 4096, 8192, 32768]) {
    test(`窓 ${window} で ${Math.round(SYSTEM_SHARE * 100)}% を超えない`, async () => {
      const root = await crowded();
      const text = await systemAt(window, root);
      const used = estimateTokens(text);
      const budget = Math.floor(window * SYSTEM_SHARE);
      assert.ok(used <= budget + 40, `前置きが窓を食っている: ${used} / 予算 ${budget}（窓 ${window}）`);
    });
  }

  test('狭くても、決まり本体と学びは残る', async () => {
    // **削る順があること。**狭いからと全部落とすと、何のための前置きか
    // 分からなくなる。いちばん要るものから残す。
    const root = await crowded();
    const text = await systemAt(2048, root);
    // 決まり本体（設定の system）は、どんなに狭くても落とさない。
    assert.ok(text.includes(DEFAULT_CONFIG.system!.slice(0, 20)), `決まり本体が落ちている: ${text.slice(0, 120)}`);
    assert.ok(text.includes('二度としないこと'), '学びが落ちている');
  });

  test('広ければ、置き場の決まりも載る（対）', async () => {
    const root = await crowded();
    const text = await systemAt(32768, root);
    assert.ok(text.includes('AGENTS.md'), '広いのに置き場の決まりが載っていない');
  });
});

/**
 * 依頼と履歴の取り分が、残っている。
 *
 * 前置き・道具の説明・返事のための取り置き。**どれも別々に決まっていて、
 * 合計を誰も見ていなかった。**窓 4096 では、依頼と履歴に 90 トークンしか
 * 残らなかった（実測）。道具の結果ひとつの上限が 2000 なので、
 * ファイルを一度読んだ時点で溢れる。
 *
 * ここは数字ではなく**配分そのもの**を留める。数字を直しても、次に誰かが
 * 定数を足せば元に戻る。
 */
describe('依頼と履歴の取り分', () => {
  const WINDOWS = [2048, 4096, 5734, 8192, 16852, 32768];

  test('どの窓でも、依頼と履歴に窓の 25% 以上が残る', async () => {
    const { estimateTokens: size, trimSchemas, tokenBudget } = await import('../src/agent/window.ts');
    const fs = await import('../src/agent/tools/fs.ts');
    const find = await import('../src/agent/tools/find.ts');
    const services = await import('../src/agent/tools/services.ts');
    const tools = [
      fs.readFileTool, fs.listFilesTool, fs.searchTextTool, fs.writeFileTool, fs.editFileTool,
      find.findCodeTool, services.listServicesTool, services.createConnectServiceTool(),
      services.createDisconnectServiceTool(),
    ].map((t) => t.schema);

    for (const w of WINDOWS) {
      const preamble = Math.floor(w * SYSTEM_SHARE);
      const schemas = trimSchemas(tools, w).reduce((n, x) => n + size(JSON.stringify(x)), 0);
      const reserve = w - tokenBudget(w);
      const left = w - preamble - schemas - reserve;
      assert.ok(
        left >= w * 0.25,
        `窓 ${w}: 依頼と履歴に ${left} しか残らない（前置き ${preamble} / 道具 ${schemas} / 返事 ${reserve}）`,
      );
    }
  });

  test('返事のための取り置きも、窓に合わせる', async () => {
    const { tokenBudget } = await import('../src/agent/window.ts');
    for (const w of WINDOWS) {
      const reserve = w - tokenBudget(w);
      assert.ok(reserve <= w * 0.25 + 1, `取り置きが窓を食っている: 窓 ${w} で ${reserve}`);
    }
  });
});

describe('動かないものを先、変わるものを後ろ', () => {
  /**
   * 相手（llama.cpp / ollama）は**前と同じ頭**を再計算しない。頭のどこか
   * 一文字が変われば、そこから先は全部やり直しで、**履歴も巻き添えになる**。
   * 前置きは依頼の前に置かれるので、ここの並びがそのまま待ち時間になる。
   *
   * 直す前は base → 作業場の様子 → 置き場の決まり → 地図 → 学び の順で、
   * いちばん変わる地図の後ろに、変わらない決まりが置かれていた。
   * 続けて別の依頼をしたとき、**頭の 41% しか同じでなかった**（実測）。
   */
  test('**変わるものが、変わらないものより後ろに来る**', async () => {
    const root = await tempDir('aas-order-');
    await writeFile(join(root, 'AGENTS.md'), 'この置き場の決まり。守ること。\n', 'utf8');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'core.ts'),
      'export function heartbeat() { return 1; }\n', 'utf8');

    const prompt = await systemAt(32_000, root);

    const rulesAt = prompt.indexOf('この置き場の決まり');
    const neverAt = prompt.indexOf('二度としないこと');
    const mapAt = prompt.indexOf('作業場の地図');
    assert.ok(rulesAt >= 0, `決まりが入っていない: ${prompt.slice(0, 200)}`);
    assert.ok(neverAt >= 0, '学びが入っていない');
    assert.ok(mapAt >= 0, '地図が入っていない');

    assert.ok(rulesAt < neverAt, `決まりより先に学びが来ている: ${rulesAt} vs ${neverAt}`);
    assert.ok(neverAt < mapAt, `学びより先に地図が来ている: ${neverAt} vs ${mapAt}`);
  });
});

describe('狭い窓では、後から足したものを先に捨てる', () => {
  /**
   * 地図に取り分を作るために、残りを 6:4 で分けた。そのとき
   * **窓 4096 で、利用者が書いた決まりが丸ごと落ちた**（実測で ○ → ×）。
   *
   * 利用者が `AGENTS.md` や `CLAUDE.md` に書いたものは、こちらが後から足した
   * 地図より重い。しかも囲みだけで 100 前後あるので、半端な取り分を渡すと
   * 「何も載らない」に倒れる。**狭いときに捨てるのは、後から足した方。**
   */
  test('**窓が狭くても、置き場の決まりは載る**', async () => {
    const root = await tempDir('aas-narrow-rules-');
    await writeFile(join(root, 'AGENTS.md'),
      'この置き場の決まり。\n- 日本語で書く\n- 検査を消さない\n'.repeat(6), 'utf8');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'core.ts'), 'export function heartbeat() { return 1; }\n', 'utf8');

    const prompt = await systemAt(4096, root);
    assert.match(prompt, /この置き場の決まり/, `決まりが落ちている:\n${prompt.slice(0, 400)}`);
  });

  test('窓が広ければ、決まりと地図の両方が載る（対）', async () => {
    const root = await tempDir('aas-wide-both-');
    await writeFile(join(root, 'AGENTS.md'), 'この置き場の決まり。\n- 日本語で書く\n', 'utf8');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'core.ts'), 'export function heartbeat() { return 1; }\n', 'utf8');

    const prompt = await systemAt(32_000, root);
    assert.match(prompt, /この置き場の決まり/);
    assert.match(prompt, /作業場の地図/);
  });
});
