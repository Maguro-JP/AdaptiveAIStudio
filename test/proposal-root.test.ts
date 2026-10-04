/**
 * 提案は、出た作業場のもの。別の作業場では決めない（採用すると、その作業場で手順が走っていた）。
 * どの思考から出たかを提案に残し、立ち上げ直した後の採否もその思考の実績に乗せる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-proposal-root-state-');
const { Session } = await import('../src/core/session.ts');
const { placeKey } = await import('../src/memory/memory.ts');

const config = (root: string) => ({
  providers: [{ id: 'l', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', locality: 'local', models: ['m'] }],
  candidates: ['l:m'],
  runtime: { kind: 'none' },
  agent: { root, approval: 'auto', verify: { enabled: false } },
  initiative: { enabled: false },
}) as never;

test('別の作業場の提案は決めず、開いたまま残す。出た作業場では決められ、出どころの思考の実績に乗る', async () => {
  const a = await tempDir('aas-proposal-root-a-');
  const b = await tempDir('aas-proposal-root-b-');
  const atB = await Session.create(config(b), { approve: () => Promise.resolve(true) });
  try {
    const p = atB.proposals.add({
      kind: 'bug', title: 'A の空の catch を直す', rationale: 'r', evidence: [], suggestedAction: 'src/x.ts を直す',
      fingerprint: 'f-root', root: placeKey(a), origin: 'patrol',
    })!;
    assert.equal(await atB.decide(p.id, 'accepted'), undefined, '別の作業場で採用できた');
    assert.equal(atB.proposals.find(p.id)?.status, 'open');
  } finally {
    await atB.close();
  }
  // 出た作業場の Session（立ち上げ直した後にあたる。手元の出どころは持っていない）
  const atA = await Session.create(config(a), { approve: () => Promise.resolve(true) });
  try {
    const p = atA.proposals.add({
      kind: 'bug', title: 'A の別の提案', rationale: 'r', evidence: [], suggestedAction: 'a',
      fingerprint: 'f-root-2', root: placeKey(a), origin: 'patrol',
    })!;
    const before = atA.idle.stats().find((s) => s.mode === 'patrol')?.accepted ?? 0;
    assert.ok(await atA.decide(p.id, 'accepted'));
    assert.equal(atA.idle.stats().find((s) => s.mode === 'patrol')?.accepted, before + 1, '出どころの思考の実績に乗っていない');
  } finally {
    await atA.close();
  }
});
