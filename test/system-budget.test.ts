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
import { writeFile } from 'node:fs/promises';
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
