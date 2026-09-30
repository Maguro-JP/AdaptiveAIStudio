/**
 * 監査・測った数・名簿を残せなかったとき、黙らない。ただし続けて失敗している間は一度だけ言う。
 *
 * どれも「記録に失敗しても本体は止めない」ために失敗を捨てていたので、書けない場所を指していても誰も気づかなかった。
 * 監査が残らないと、ハーネスがなぜ止めた・通したかを後から追えない。毎回言うと、ツールを一回呼ぶたびに同じ警告が出る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { AuditLog } from '../src/harness/audit.ts';
import { HarnessMetrics } from '../src/harness/metrics.ts';
import { RoleLedger } from '../src/roles/ledger.ts';
import { startFakeServer } from './fake-server.ts';
import { Session } from '../src/core/session.ts';
import { DEFAULT_CONFIG, type AasConfig } from '../src/config.ts';

/** 親フォルダの名前にファイルを置いて、その下へ書けなくする（root でも書けない） */
async function blocked(): Promise<{ dir: string; path: (name: string) => string; unblock: () => Promise<void>; reblock: () => Promise<void> }> {
  const root = await tempDir('aas-record-warn-');
  const dir = join(root, 'state');
  await writeFile(dir, 'ここはフォルダではない');
  return {
    dir,
    path: (name) => join(dir, name),
    unblock: async () => { await rm(dir, { force: true }); await mkdir(dir); },
    // Windows でウイルス対策が付け替えた直後のファイルを掴んでも落ちないよう、待って消し直す
    reblock: async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await writeFile(dir, 'ここはフォルダではない'); },
  };
}

describe('記録を残せなかったことを言う', () => {
  test('監査: 続けて失敗している間は一度だけ言い、書けた後にまた失敗したら、また言う', async () => {
    const b = await blocked();
    const warned: string[] = [];
    const audit = new AuditLog(b.path('audit.jsonl'));
    audit.warnTo((t) => warned.push(t));
    await audit.record({ tool: 'read_file', outcome: 'allowed' });
    await audit.record({ tool: 'read_file', outcome: 'allowed' });
    assert.equal(warned.length, 1, `一度だけのはず: ${JSON.stringify(warned)}`);
    assert.match(warned[0]!, /監査の記録を残せませんでした/);
    await b.unblock();
    await audit.record({ tool: 'read_file', outcome: 'allowed' });
    assert.equal(warned.length, 1, '書けたのに言った');
    await b.reblock();
    await audit.record({ tool: 'read_file', outcome: 'denied' });
    assert.equal(warned.length, 2, '書けた後の失敗を言わなかった');
    assert.equal(audit.entries().length, 4, '手元の記録は失敗しても残す');
  });

  test('測った数: 続けて失敗している間は一度だけ言う', async () => {
    const b = await blocked();
    const warned: string[] = [];
    const metrics = new HarnessMetrics(b.path('harness-metrics.json'));
    metrics.warnTo((t) => warned.push(t));
    await metrics.save();
    await metrics.save();
    assert.equal(warned.length, 1, `一度だけのはず: ${JSON.stringify(warned)}`);
    assert.match(warned[0]!, /測った数を残せませんでした/);
    await b.unblock();
    await metrics.save();
    await b.reblock();
    await metrics.save();
    assert.equal(warned.length, 2, '書けた後の失敗を言わなかった');
  });

  test('名簿: 残せたかを返す', async () => {
    const b = await blocked();
    const ledger = new RoleLedger(b.path('roles-ledger.json'));
    assert.equal(await ledger.save(), false);
    await b.unblock();
    assert.equal(await ledger.save(), true);
  });

  test('言う先を繋ぐ前の失敗は「言った」ことにせず、繋いだ後の失敗で言う', async () => {
    const b = await blocked();
    const warned: string[] = [];
    const audit = new AuditLog(b.path('audit.jsonl'));
    await audit.record({ tool: 'read_file', outcome: 'allowed' });
    audit.warnTo((t) => warned.push(t));
    await audit.record({ tool: 'read_file', outcome: 'allowed' });
    assert.equal(warned.length, 1, `繋いだ後の失敗を言わなかった: ${JSON.stringify(warned)}`);
  });

  test('書き先を持たない記録は、書かないので何も言わない', async () => {
    const warned: string[] = [];
    const audit = new AuditLog();
    audit.warnTo((t) => warned.push(t));
    await audit.record({ tool: 'x', outcome: 'allowed' });
    const metrics = new HarnessMetrics();
    metrics.warnTo((t) => warned.push(t));
    await metrics.save();
    assert.deepEqual(warned, []);
    assert.equal(await new RoleLedger().save(), true);
  });
});

describe('画面の本体まで届く', () => {
  test('ツールを呼んで監査を残せなかったら、warn で一度だけ言う', async () => {
    const b = await blocked();
    const root = await tempDir('aas-record-warn-root-');
    await writeFile(join(root, 'a.txt'), 'なかみ\n');
    const fake = await startFakeServer({ kind: 'toolcall', name: 'read_file', args: { path: 'a.txt' }, then: '読みました。' });
    const logs: string[] = [];
    const session = await Session.create({
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      agent: { root, approval: 'auto' },
      harness: { ...(DEFAULT_CONFIG.harness ?? {}), auditLog: b.path('audit.jsonl') },
    } as AasConfig, {
      approve: () => Promise.resolve(true),
      onLog: (level, text) => { if (level === 'warn') logs.push(text); },
    });
    try {
      for (let i = 0; i < 2; i++) for await (const _ of session.send('a.txt を読んで')) { /* 流し切る */ }
      const said = logs.filter((t) => /監査の記録を残せませんでした/.test(t));
      assert.equal(said.length, 1, `一度だけのはず: ${JSON.stringify(logs)}`);
    } finally {
      await session.close();
      await fake.close();
    }
  });
});
