/**
 * 本体（Session）の後半の不具合（66 回目の調査）。
 *
 * - 利用者が止めた回を、答えていたモデルの失敗として成績に付けた（止めることの多いモデルほど選ばれにくくなった）
 * - 立ち上げ直後の最初の依頼で下調べが 2 秒に間に合わないと、黙って確かめのコマンドを決めず、確かめを飛ばした
 *
 * CLI の `/do` が提案文を利用者の言葉として判じ手に渡していた件と、前の回の「元から落ちていた」を「確かめていない」と写していた件は、
 * 端末を通す試験と判じ手の偽物が要るので書いていない（確かめていない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';

const state = await tempDir('aas-session-back-');
process.env.AAS_STATE_DIR = state;
const { Session } = await import('../src/core/session.ts');
const { Prefetcher } = await import('../src/agent/prefetch.ts');

interface Stat { modelId: string; successes: number; failures: number }
async function stats(): Promise<Stat[]> {
  const raw = await readFile(join(state, 'metrics.json'), 'utf8').catch(() => '[]');
  const parsed = JSON.parse(raw) as Stat[] | { stats?: Stat[] };
  return Array.isArray(parsed) ? parsed : (parsed.stats ?? []);
}

test('**止めた回は、モデルの失敗として数えない**', { timeout: 60_000 }, async () => {
  const fake = await startFakeServer({ kind: 'echo', trickleMs: 30 });
  const root = await tempDir('aas-session-back-root-');
  try {
    const session = await Session.create({
      providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'cloud', models: ['m'] }],
      candidates: ['p:m'],
      runtime: { kind: 'none' },
      agent: { root, approval: 'auto', verify: { enabled: false }, maxTurns: 1 },
      initiative: { enabled: false },
    } as never, { approve: () => Promise.resolve(true) });
    let chars = 0;
    let reason = '';
    for await (const ev of session.send('1234567890'.repeat(20))) {
      if (ev.type === 'text') { chars += (ev as { delta: string }).delta.length; if (chars > 5) session.abort(); }
      if (ev.type === 'finished') reason = (ev as { reason: string }).reason;
    }
    await session.close();
    assert.equal(reason, 'aborted', '前提: 止まっていない');
    const mine = (await stats()).find((s) => s.modelId === 'p:m');
    assert.equal(mine?.failures ?? 0, 0, `止めた回を失敗として数えた: ${JSON.stringify(mine)}`);
  } finally {
    await fake.close();
  }
});

test('**下調べが 2 秒に間に合わなくても、確かめのコマンドを決める**', { timeout: 60_000 }, async () => {
  const root = await tempDir('aas-session-back-slow-');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
  const original = Prefetcher.prototype.snapshotWithin;
  let calls = 0;
  // 最初の 2 秒は間に合わなかったことにする
  Prefetcher.prototype.snapshotWithin = async function (this: InstanceType<typeof Prefetcher>, ms: number) {
    calls += 1;
    if (calls === 1) return undefined;
    return original.call(this, ms);
  };
  try {
    const session = await Session.create({
      providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', locality: 'cloud', models: ['m'] }],
      candidates: ['p:m'],
      runtime: { kind: 'none' },
      agent: { root, approval: 'auto' },
      initiative: { enabled: false },
    } as never, { approve: () => Promise.resolve(true) });
    try {
      const command = await session.verifyCommand();
      assert.ok(command, '間に合わなかった回に、確かめのコマンドを決めなかった');
    } finally {
      await session.close();
    }
  } finally {
    Prefetcher.prototype.snapshotWithin = original;
  }
});
