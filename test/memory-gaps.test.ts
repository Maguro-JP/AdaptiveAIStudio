/**
 * 覚えて使い回す仕組みの抜け（15 回目の調査）。
 *
 * - 秘密（API キー）を記憶・提案に残さない
 * - 添付だけを送った回は、添付の名前で呼ぶ（中身を記憶の題にしない）
 * - 毎週の当番（atHour あり）を、先週済ませていれば「前回分が残っています」にしない
 * - 記憶の時刻が未来（時計のずれ）でも、思い出す順・嫌がられたことの順を崩さない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from '../src/memory/memory.ts';
import { ProposalQueue } from '../src/agent/proposals.ts';
import { DutyRoster, type Duty } from '../src/harness/duties.ts';
import { saidOrAttached } from '../src/core/session.ts';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const DAY = 86_400_000;
// 鍵の形をした作り物（本物ではない）
const KEY = `sk-ant-api03-${'Ab1'.repeat(10)}`;

describe('秘密を残さない', () => {
  test('記憶の題と中身から API キーを伏せる', () => {
    const m = new Memory();
    m.remember({ kind: 'attempt', title: `このキー ${KEY} を .env に入れて`, detail: `API_KEY=${KEY}` });
    const e = m.all()[0]!;
    assert.ok(!e.title.includes(KEY) && !e.detail.includes(KEY), JSON.stringify(e));
  });
  test('提案の題・理由・手順から API キーを伏せる', () => {
    const q = new ProposalQueue();
    const p = q.add({ kind: 'bug', title: `鍵 ${KEY}`, rationale: `.env に ${KEY}`, evidence: [], suggestedAction: `export KEY=${KEY}`, fingerprint: 'f' })!;
    assert.ok(![p.title, p.rationale, p.suggestedAction].some((t) => t.includes(KEY)), JSON.stringify(p));
  });
});

describe('添付だけを送った回の名前', () => {
  test('添付の中身ではなく、名前で呼ぶ', () => {
    const name = saidOrAttached('', `--- 添付: .env ---\nAPI_KEY=${KEY}\n--- ここまで ---`);
    assert.equal(name, '添付（.env）を送った回');
  });
  test('打った分があればそれ、渡さない呼び手は依頼のまま（対）', () => {
    assert.equal(saidOrAttached('直して', '--- 添付: a ---\nx\n--- ここまで ---\n\n直して'), '直して');
    assert.equal(saidOrAttached(undefined, '直して'), '直して');
  });
});

describe('毎週の当番の前回分', () => {
  const duty: Duty = {
    id: 'w', codename: 'WEEKLY', name: '週', purpose: 'p', modeId: 'retrospect', importance: 1,
    cadence: { kind: 'weekly', weekday: 1, atHour: 9 }, catchUp: true,
  } as Duty;
  test('先週の月曜 10 時に済ませていれば、今週の月曜 9:30 は前回分ではない', () => {
    const roster = new DutyRoster([duty]);
    roster.complete('w', new Date(2026, 8, 28, 10, 0).getTime());
    const st = roster.status(new Date(2026, 9, 5, 9, 30).getTime())[0]!;
    assert.equal(st.due, true);
    assert.equal(st.isCatchUp, false);
  });
  test('二週前に済ませたきりなら、前回分が残っている（対）', () => {
    const roster = new DutyRoster([duty]);
    roster.complete('w', new Date(2026, 8, 21, 10, 0).getTime());
    assert.equal(roster.status(new Date(2026, 9, 5, 9, 30).getTime())[0]!.isCatchUp, true);
  });
});

describe('未来の時刻の記憶', () => {
  test('思い出す順で、未来の時刻の覚えが語の重なりの多い覚えを追い越さない', () => {
    const m = new Memory();
    const now = Date.now();
    m.remember({ kind: 'fact', title: 'lodash の話', now: now + 29 * DAY });
    m.remember({ kind: 'fact', title: 'lodash の版 4 の既知の不具合', now });
    const got = m.recall('lodash の版 4 の既知の不具合', { limit: 2 });
    assert.equal(got[0]?.title, 'lodash の版 4 の既知の不具合', JSON.stringify(got.map((e) => e.title)));
  });
  test('読み直すと未来の時刻は今に丸まり、その後に覚えた嫌がられたことが先頭に来る', async () => {
    const path = join(await tempDir('aas-memory-future-'), 'memory.jsonl');
    const m = new Memory(path);
    await m.load();
    m.remember({ kind: 'displeasure', title: '時計が進んでいた間の一件', now: Date.now() + 365 * DAY });
    await m.save();
    const next = new Memory(path);
    await next.load();
    await new Promise((r) => setTimeout(r, 5));
    next.remember({ kind: 'displeasure', title: '後から覚えた一件' });
    assert.equal(next.displeasures(1)[0]?.title, '後から覚えた一件');
  });
});
