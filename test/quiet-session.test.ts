/**
 * 検問所と判じ手の候補は、Session を立てたときに設定から組む（`quietCandidates` を session に繋いだ所を見る）。
 *
 * 関数だけを見る試験では、session の繋ぎを元の逆順に戻しても通った。設定で固定した候補（強い順に書く）から、
 * 手元のモデルだけを軽い方から並べることを、立てた Session で見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-quiet-state-');
const { Session } = await import('../src/core/session.ts');

test('設定で固定した候補から、手元のモデルだけを軽い方から使う（雲は入れない）', async () => {
  const root = await tempDir('aas-quiet-root-');
  const session = await Session.create({
    providers: [
      { id: 'l', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', locality: 'local', models: ['big', 'small'] },
      { id: 'c', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', locality: 'cloud', models: ['x'] },
    ],
    candidates: ['l:big', 'c:x', 'l:small'],
    runtime: { kind: 'none' },
    agent: { root, approval: 'auto', verify: { enabled: false } },
    initiative: { enabled: false },
  } as never, { approve: () => Promise.resolve(true) });
  try {
    assert.deepEqual(session.quiet, ['l:small', 'l:big']);
  } finally {
    await session.close();
  }
});
