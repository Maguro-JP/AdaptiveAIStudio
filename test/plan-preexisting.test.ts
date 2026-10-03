/**
 * 作業前から落ちている作業場でも、落ち方が変わったら「元から」と言わない・巻き戻す。（02）
 *
 * 確かめは broke.txt が在ると別の文で落ちる。担当（fake の toolcall）が broke.txt を書く。
 * 直す前は 'preexisting'（「今回の作業が原因ではありません」）になり、rollbackOnGiveUp でも残っていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-plan-pre-state-');
const { Session } = await import('../src/core/session.ts');

const VERIFY = `node -e "const b=require('fs').existsSync('broke.txt');console.log(b?'NEW FAILURE':'OLD FAILURE');process.exit(1)"`;

async function open(root: string, baseUrl: string, verify: string) {
  return Session.create({
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'], runtime: { kind: 'none' },
    agent: { root, approval: 'auto', maxTurns: 3, verify: { command: verify } },
    harness: { rollbackOnGiveUp: true },
    initiative: { enabled: false },
  } as never, { approve: () => Promise.resolve(true) });
}

test('落ち方が変わったら failed にして巻き戻す', async () => {
  const fake = await startFakeServer({ kind: 'toolcall', name: 'write_file', args: { path: 'broke.txt', content: 'x' }, then: '書きました。' });
  const root = await tempDir('aas-plan-pre-root-');
  const session = await open(root, fake.baseUrl, VERIFY);
  try {
    let report: { verified: string } | undefined;
    for await (const ev of session.plan('broke.txt を作って')) if (ev.type === 'accepted') report = ev.report;
    assert.equal(report?.verified, 'failed', '落ち方が変わったのに「元から」と言った');
    await assert.rejects(stat(join(root, 'broke.txt')), '確かめて落ちたのに巻き戻していない');
  } finally {
    await session.close();
    await fake.close();
  }
});

test('同じ落ち方なら preexisting（対）', async () => {
  const fake = await startFakeServer({ kind: 'toolcall', name: 'write_file', args: { path: 'other.txt', content: 'x' }, then: '書きました。' });
  const root = await tempDir('aas-plan-pre-root2-');
  const session = await open(root, fake.baseUrl, VERIFY);
  try {
    let report: { verified: string } | undefined;
    for await (const ev of session.plan('other.txt を作って')) if (ev.type === 'accepted') report = ev.report;
    assert.equal(report?.verified, 'preexisting');
  } finally {
    await session.close();
    await fake.close();
  }
});
