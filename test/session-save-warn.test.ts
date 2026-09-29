/**
 * 提案・覚えたことを残せなかったとき、黙らない。
 *
 * 提案の保存は読めない・書けないと黙って抜け、呼ぶ側は画面へ「提案」を流していた。覚えたことの保存は失敗を捨て、
 * 直後に「覚えました」と言っていた。どちらも立ち上げ直すと消えるのに、誰も気づかない。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { Session } from '../src/core/session.ts';
import { DEFAULT_CONFIG, type AasConfig } from '../src/config.ts';

let fake: FakeServer;
let root = '';

before(async () => {
  root = await tempDir('aas-save-warn-');
  fake = await startFakeServer({ kind: 'stream', text: 'はい。' });
});
after(async () => { await fake.close(); });

function config(): AasConfig {
  return {
    ...DEFAULT_CONFIG,
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'],
    agent: { root, approval: 'auto' },
  } as AasConfig;
}

describe('残せなかったことを言う', () => {
  test('提案を残せなかったら warn で言う', async () => {
    const logs: string[] = [];
    const session = await Session.create(config(), {
      approve: () => Promise.resolve(true),
      onLog: (level, text) => { if (level === 'warn') logs.push(text); },
    });
    try {
      session.proposals.save = () => Promise.resolve(new Error('提案の記録を読めないので、残せませんでした（EBUSY）'));
      await session.saveProposals();
      assert.ok(logs.some((t) => /残せませんでした/.test(t)), `黙った: ${JSON.stringify(logs)}`);
    } finally { await session.close(); }
  });

  test('覚えたことを残せなかったら warn で言う', async () => {
    const logs: string[] = [];
    const session = await Session.create(config(), {
      approve: () => Promise.resolve(true),
      onLog: (level, text) => { if (level === 'warn') logs.push(text); },
    });
    const real = session.memory.save.bind(session.memory);
    try {
      session.memory.save = () => Promise.reject(new Error('ENOSPC: no space left'));
      await session.saveMemory();
      assert.ok(logs.some((t) => /覚えたことを残せませんでした/.test(t)), `黙った: ${JSON.stringify(logs)}`);
    } finally {
      session.memory.save = real;
      await session.close();
    }
  });
});
