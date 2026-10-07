/**
 * 本体（Session）の前半の不具合（65 回目の調査）。
 *
 * - 提案の採否を決めるとき、手元に無い提案（もう一方のプロセスが後から足した分）は作業場の確かめを素通りし、別の作業場の提案を決めた
 *
 * 段取りを止めた・落ちた回、送り口で書いたのに確かめずに終わった回に、覚えている作業前の姿を忘れていなかった件と、段取りの
 * 止めた・落ちた回に呼び戻した覚えの記録を捨てていなかった件は、止まる偽のモデルが要るので試験を書いていない（確かめていない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const state = await tempDir('aas-session-front-state-');
process.env.AAS_STATE_DIR = state;
const { Session } = await import('../src/core/session.ts');
const { placeKey } = await import('../src/memory/memory.ts');
const { ProposalQueue } = await import('../src/agent/proposals.ts');

const config = (root: string) => ({
  providers: [{ id: 'l', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', locality: 'local', models: ['m'] }],
  candidates: ['l:m'],
  runtime: { kind: 'none' },
  agent: { root, approval: 'auto', verify: { enabled: false } },
  initiative: { enabled: false },
}) as never;

test('**手元に無い別の作業場の提案も、決めない**', async () => {
  const a = await tempDir('aas-session-front-a-');
  const b = await tempDir('aas-session-front-b-');
  const atB = await Session.create(config(b), { approve: () => Promise.resolve(true) });
  try {
    // もう一方のプロセス（作業場 A）が、後から提案を足して保存する。atB の手元には無い
    const other = new ProposalQueue(join(state, 'proposals.json'));
    await other.load();
    const p = other.add({
      kind: 'bug', title: 'A だけの提案', rationale: 'r', evidence: [], suggestedAction: 'src/x.ts を直す',
      fingerprint: 'f-front', root: placeKey(a),
    })!;
    assert.equal(await other.save(), undefined);
    assert.equal(atB.proposals.find(p.id), undefined, '前提: atB の手元には無い');
    assert.equal(await atB.decide(p.id, 'accepted'), undefined, '別の作業場の提案を決めた');
    const disk = new ProposalQueue(join(state, 'proposals.json'));
    await disk.load();
    assert.equal(disk.find(p.id)?.status, 'open', 'ファイルの上で決まってしまった');
  } finally {
    await atB.close();
  }
});
