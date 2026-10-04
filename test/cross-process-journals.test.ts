/**
 * 画面と端末のように、別々に読み込んで持つ二つの実体が同じ記録を書いても、片方が書いた分を消さない。
 *
 * 二つの実体は、同じプロセスの中でも「別々に読んで、手元を丸ごと書く」なら同じ消え方をする。
 * ここでは二つの入れ物を同じファイルから読み、交互に書いて、両方の分が残ることを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, utimes, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { loadJournal, saveMerged } from '../src/core/journal-file.ts';
import { withFileLock, FileLockBusy } from '../src/core/file-lock.ts';
import { IdleScheduler } from '../src/harness/idle.ts';
import { BUILTIN_IDLE_MODES } from '../src/harness/idle-modes.ts';
import { DutyRoster, type DutyRecord } from '../src/harness/duties.ts';
import { BUILTIN_DUTIES } from '../src/harness/builtin-duties.ts';
import { ProposalQueue } from '../src/agent/proposals.ts';

const NOW = Date.UTC(2026, 8, 1, 3, 0, 0); // 今より前（未来の時刻は読むときに今へ寄せられる）
const [D1, D2] = BUILTIN_DUTIES.map((d) => d.id);
const MODE = BUILTIN_IDLE_MODES[0]!;
const idle = () => new IdleScheduler(BUILTIN_IDLE_MODES, { perHour: 12, minGapMs: 600_000, maxPerChange: 2 });

async function roster(path: string): Promise<DutyRoster> {
  const r = new DutyRoster(BUILTIN_DUTIES);
  await loadJournal(r, path, (v) => r.restore(v as never));
  return r;
}
const saveRoster = (r: DutyRoster, path: string) =>
  saveMerged(r, path, () => JSON.stringify(r.records()), (v, seen) => r.rebase(v, seen));
const recordOf = async (path: string, id: string): Promise<DutyRecord> =>
  (JSON.parse(await readFile(path, 'utf8')) as DutyRecord[]).find((x) => x.dutyId === id)!;

describe('当番の記録（duties.json）', () => {
  test('**もう一方が済ませた当番を、後から書いた方が消さない**', async () => {
    const path = join(await tempDir('aas-xproc-'), 'duties.json');
    const a = await roster(path);
    const b = await roster(path);
    a.complete(D1!, NOW);
    assert.equal(await saveRoster(a, path), true);
    b.complete(D2!, NOW);
    assert.equal(await saveRoster(b, path), true);
    assert.equal((await recordOf(path, D1!)).completions, 1, '画面が済ませた分が残る');
    assert.equal((await recordOf(path, D2!)).completions, 1, '端末が済ませた分も残る');
    assert.ok((await recordOf(path, D1!)).lastPeriod, '済ませた期も残る（もう一度「やるべき」に戻らない）');
    assert.equal((await roster(path)).due(NOW).some((s) => s.duty.id === D1), false);
  });

  test('同じ実体が何度書いても、二重に足さない', async () => {
    const path = join(await tempDir('aas-xproc-'), 'duties.json');
    const a = await roster(path);
    a.complete(D1!, NOW);
    await saveRoster(a, path);
    await saveRoster(a, path);
    const b = await roster(path);
    await saveRoster(b, path);
    await saveRoster(a, path);
    assert.equal((await recordOf(path, D1!)).completions, 1);
  });

  test('**起動のときにファイルが在っても、手元で済ませた分を消さない**', async () => {
    // 読んだ値と「前に見た中身」が同じものを指していると、手元で数えるたびに前に見た中身も増え、差から手元の分が引かれていた
    const path = join(await tempDir('aas-xproc-'), 'duties.json');
    await writeFile(path, JSON.stringify([{ dutyId: D1, completions: 3, missed: 0, lastPeriod: 'old', lastAt: NOW - 86_400_000 * 30 }]));
    const a = await roster(path);
    const b = await roster(path);
    a.complete(D1!, NOW);
    b.complete(D2!, NOW);
    await saveRoster(b, path);
    await saveRoster(a, path);
    const r = await recordOf(path, D1!);
    assert.equal(r.completions, 4);
    assert.notEqual(r.lastPeriod, 'old', '済ませた期が古い期に戻らない');
    assert.equal((await recordOf(path, D2!)).completions, 1);
  });

  test('**書けなかった後の保存で、ほかが数えた分を二重に足さない**', async () => {
    const path = join(await tempDir('aas-xproc-'), 'duties.json');
    const a = await roster(path);
    const b = await roster(path);
    b.complete(D1!, NOW);
    await saveRoster(b, path);
    const failRename = async () => { throw Object.assign(new Error('busy'), { code: 'EACCES' }); };
    assert.equal(await saveMerged(a, path, () => JSON.stringify(a.records()), (v, seen) => a.rebase(v, seen), { rename: failRename }), false);
    assert.equal(await saveRoster(a, path), true);
    assert.equal((await recordOf(path, D1!)).completions, 1);
  });

  test('前に見た中身が無くても、ほかが後に済ませた期で古い期を残さない', async () => {
    const path = join(await tempDir('aas-xproc-'), 'duties.json');
    const b = await roster(path); // ファイルが無いうちに読む（前に見た中身が無い）
    b.complete(D1!, NOW);
    const a = await roster(path);
    a.complete(D1!, NOW + 86_400_000);
    await saveRoster(a, path);
    await saveRoster(b, path);
    assert.equal((await recordOf(path, D1!)).lastAt, NOW + 86_400_000);
    const later = (await roster(path)).status(NOW + 86_400_000).find((s) => s.duty.id === D1)!;
    assert.equal(later.doneThisPeriod, true, '後に済ませた期が残る');
  });

  test('両方が同じ当番を済ませたら、回数は両方の分、期は後に済ませた方', async () => {
    const path = join(await tempDir('aas-xproc-'), 'duties.json');
    const a = await roster(path);
    const b = await roster(path);
    a.complete(D1!, NOW);
    b.complete(D1!, NOW + 86_400_000);
    await saveRoster(a, path);
    await saveRoster(b, path);
    await saveRoster(a, path);
    const r = await recordOf(path, D1!);
    assert.equal(r.completions, 2);
    assert.equal(r.lastAt, NOW + 86_400_000);
  });
});

describe('暇の実績（idle.json）', () => {
  test('**両方が数えた実績が、どちらも残る**', async () => {
    const path = join(await tempDir('aas-xproc-'), 'idle.json');
    const load = async () => { const s = idle(); await loadJournal(s, path, (v) => s.restore(v as never)); return s; };
    const save = (s: IdleScheduler) => saveMerged(s, path, () => JSON.stringify(s.stats()), (v, seen) => s.rebase(v, seen));
    const a = await load();
    const b = await load();
    a.begin(MODE, NOW); a.recordVerdict(MODE.id, 'accepted');
    b.begin(MODE, NOW + 1000); b.recordVerdict(MODE.id, 'rejected');
    await save(a);
    await save(b);
    await save(a);
    const got = (JSON.parse(await readFile(path, 'utf8')) as Array<{ mode: string; runs: number; accepted: number; rejected: number; lastRunAt?: number }>)
      .find((s) => s.mode === MODE.id)!;
    assert.equal(got.runs, 2);
    assert.equal(got.accepted, 1);
    assert.equal(got.rejected, 1);
    assert.equal(got.lastRunAt, NOW + 1000);
  });
});

describe('ほかのプロセスとの錠', () => {
  test('同時に持とうとしても、中は一つずつ通る', async () => {
    const path = join(await tempDir('aas-xproc-'), 'x.json');
    let inside = 0;
    let most = 0;
    await Promise.all(Array.from({ length: 5 }, () => withFileLock(path, async () => {
      inside++; most = Math.max(most, inside);
      await new Promise((r) => setTimeout(r, 15));
      inside--;
    })));
    assert.equal(most, 1);
    await assert.rejects(access(`${path}.lock`), '返したら錠は残らない');
  });

  test('落ちたプロセスが残した古い錠は、消して取り直す', async () => {
    const path = join(await tempDir('aas-xproc-'), 'x.json');
    await writeFile(`${path}.lock`, '99999 left-behind');
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    assert.equal(await withFileLock(path, async () => 'ok', { timeoutMs: 200 }), 'ok');
  });

  test('**古い錠を消せなくても回り続けず、期限で投げる**', async () => {
    const path = join(await tempDir('aas-xproc-'), 'x.json');
    await mkdir(`${path}.lock`); // フォルダは unlink で消せない
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    await assert.rejects(withFileLock(path, async () => undefined, { timeoutMs: 150 }), FileLockBusy);
  });

  test('**ほかが持っている間は待ち、取れなければ投げて中身に触らない**', async () => {
    const path = join(await tempDir('aas-xproc-'), 'x.json');
    await writeFile(`${path}.lock`, '99999 busy');
    let ran = false;
    await assert.rejects(withFileLock(path, async () => { ran = true; }, { timeoutMs: 100 }), FileLockBusy);
    assert.equal(ran, false);
    assert.equal(await readFile(`${path}.lock`, 'utf8'), '99999 busy', 'ほかの錠を消さない');
  });

  test('提案の保存は、ほかが錠を持っている間は待つ', async () => {
    const path = join(await tempDir('aas-xproc-'), 'proposals.json');
    const q = new ProposalQueue(path);
    await q.load();
    q.add({ title: 't', rationale: 'r', suggestedAction: 'a', fingerprint: 'f' } as never);
    await writeFile(`${path}.lock`, '99999 busy');
    let done = false;
    const saving = q.save().then((e) => { done = true; return e; });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(done, false, '錠が在る間は書かない');
    await import('node:fs/promises').then((fs) => fs.unlink(`${path}.lock`));
    assert.equal(await saving, undefined);
    assert.match(await readFile(path, 'utf8'), /"title": "t"/);
  });
});
