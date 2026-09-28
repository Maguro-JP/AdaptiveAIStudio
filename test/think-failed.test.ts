/**
 * 考えごとのモデルが落ちた・止められた回を、「調べた」「日課を済ませた」と記録しない。
 *
 * `Agent.run` はモデルが落ちても投げず、`finished`（`failed`・`aborted`）で終わる。その理由を見ずに記録していたので、
 * 繋がらなかった回も止めた回も、手がかりは二度と調べられず（`seen` に入る）、その日の日課は済んだことになった。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';

const home = await tempDir('aas-think-failed-');
process.env.AAS_HOME = home;
process.env.AAS_STATE_DIR = join(home, 'state');
const { Session } = await import('../src/core/session.ts');
type ThinkEvent = import('../src/core/session.ts').ThinkEvent;
const { DEFAULT_CONFIG } = await import('../src/config.ts');

async function sessionWith(fake: { baseUrl: string }, name: string) {
  const work = join(home, name);
  await mkdir(work, { recursive: true });
  process.env.AAS_STATE_DIR = join(home, `state-${name}`);
  const config = {
    ...DEFAULT_CONFIG,
    providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['p:m'],
    runtime: { kind: 'ollama' },
    agent: { root: work, approval: 'auto' },
  } as typeof DEFAULT_CONFIG;
  return Session.create(config, { approve: () => Promise.resolve(true) });
}

test('**モデルが落ちた回は、日課を済ませたことにせず、考えられなかったと言う**', async () => {
  const fake = await startFakeServer({ kind: 'status', status: 500, body: '{"error":"down"}' });
  const session = await sessionWith(fake, 'down');
  try {
    const before = session.duties.due(Date.now()).map((d) => d.duty.id);
    const seen: ThinkEvent[] = [];
    for await (const e of session.think()) seen.push(e);
    const chose = seen.find((e) => e.type === 'chose');
    assert.ok(chose && chose.type === 'chose' && chose.isDuty, `日課を選んでいない（この試験の前提が崩れた）: ${JSON.stringify(seen)}`);
    assert.deepEqual(session.duties.due(Date.now()).map((d) => d.duty.id), before, '落ちた回で、日課を済ませたことにした');
    assert.ok(seen.some((e) => e.type === 'failed' && e.codename === (chose as { codename: string }).codename),
      `考えられなかったと言っていない: ${JSON.stringify(seen)}`);
    assert.ok(!seen.some((e) => e.type === 'noFinding'), '落ちた回を「見つからなかった」と言った');
    // 見回りの回数と間合いは残す（立ち上げ直すと間合いが戻らないように）
    const idle = await readFile(join(home, 'state-down', 'idle.json'), 'utf8').catch(() => '');
    assert.match(idle, /"runs":\s*1/, `落ちた回の見回りを保存していない: ${idle.slice(0, 200)}`);
  } finally {
    await session.close();
    await fake.close();
  }
});

test('**返事が空のまま止まった回も、日課を済ませたことにしない**', async () => {
  const fake = await startFakeServer({ kind: 'stream', text: '' });
  const session = await sessionWith(fake, 'empty');
  try {
    const before = session.duties.due(Date.now()).map((d) => d.duty.id);
    const seen: ThinkEvent[] = [];
    for await (const e of session.think()) seen.push(e);
    assert.ok(seen.some((e) => e.type === 'chose'), JSON.stringify(seen));
    assert.deepEqual(session.duties.due(Date.now()).map((d) => d.duty.id), before, '空の返事の回で、日課を済ませたことにした');
    assert.ok(seen.some((e) => e.type === 'failed' && /空/.test(e.reason)), JSON.stringify(seen));
  } finally {
    await session.close();
    await fake.close();
  }
});

test('答えが返った回は、日課を済ませたことにする（対）', async () => {
  const fake = await startFakeServer({ kind: 'stream', text: '見回りました。気になる所はありません。' });
  const session = await sessionWith(fake, 'up');
  try {
    const before = session.duties.due(Date.now()).map((d) => d.duty.id);
    const seen: ThinkEvent[] = [];
    for await (const e of session.think()) seen.push(e);
    const chose = seen.find((e) => e.type === 'chose');
    assert.ok(chose && chose.type === 'chose' && chose.isDuty, JSON.stringify(seen));
    const after = session.duties.due(Date.now()).map((d) => d.duty.id);
    assert.equal(after.length, before.length - 1, `済ませた日課が残っている: ${JSON.stringify({ before, after })}`);
  } finally {
    await session.close();
    await fake.close();
  }
});
