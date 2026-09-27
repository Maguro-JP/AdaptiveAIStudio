/**
 * 暇の実績（`idle.json`）と当番の記録（`duties.json`）を、読めないときに空で上書きしない・途中で落ちても半分にしない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { readJournal, loadJournal, saveJournal } from '../src/core/journal-file.ts';
import { IdleScheduler } from '../src/harness/idle.ts';
import { BUILTIN_IDLE_MODES } from '../src/harness/idle-modes.ts';
import { DutyRoster } from '../src/harness/duties.ts';
import { BUILTIN_DUTIES } from '../src/harness/builtin-duties.ts';
import { loadJournals, saveJournals } from '../src/core/journals.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const busy = (code: string) => async (): Promise<string> => {
  throw Object.assign(new Error(code), { code });
};
const idle = () => new IdleScheduler(BUILTIN_IDLE_MODES, { perHour: 12, minGapMs: 600_000, maxPerChange: 2 });
const MODE = BUILTIN_IDLE_MODES[0]!.id;
const stat = (runs: number, lastRunAt?: number) =>
  ({ mode: MODE, runs, produced: runs, accepted: 0, rejected: 0, spent: runs, ...(lastRunAt ? { lastRunAt } : {}) });

describe('読む', () => {
  test('無いのは missing、在って読めないのは unreadable（EACCES）', async () => {
    const dir = await tempDir('aas-journal-');
    assert.equal((await readJournal(join(dir, 'none.json'))).kind, 'missing');
    assert.equal((await readJournal(join(dir, 'x.json'), { read: busy('EACCES') })).kind, 'unreadable');
  });

  test('**EBUSY が続くのは読めない扱い、途中で読めれば値**', async () => {
    const dir = await tempDir('aas-journal-');
    const path = join(dir, 'x.json');
    assert.equal((await readJournal(path, { read: busy('EBUSY') })).kind, 'unreadable');
    let n = 0;
    const r = await readJournal(path, { read: async () => { if (n++ < 2) throw Object.assign(new Error('b'), { code: 'EBUSY' }); return '﻿[1]'; } });
    assert.deepEqual(r, { kind: 'value', value: [1] });
  });

  test('**壊れた JSON は脇へ移して空で始める。移せなければ読めない扱い**', async () => {
    const dir = await tempDir('aas-journal-');
    const path = join(dir, 'idle.json');
    await writeFile(path, '[{"mode":');
    assert.equal((await readJournal(path)).kind, 'missing');
    const names = await readdir(dir);
    assert.ok(names.some((n) => n.startsWith('idle.json.broken-')), names.join(','));
    assert.equal(await readFile(join(dir, names.find((n) => n.startsWith('idle.json.broken-'))!), 'utf8'), '[{"mode":');

    await writeFile(path, '[{"mode":');
    assert.equal((await readJournal(path, { setAside: async () => false })).kind, 'unreadable');
  });
});

describe('暇の実績', () => {
  test('**形の違う一件（null・数でない回数）は除き、残りは読む**（投げると残りを読まず、次の保存で消していた）', () => {
    const s = idle();
    assert.doesNotThrow(() => s.restore([null, { mode: MODE, runs: 'many' }, stat(4, 1000)] as never));
    assert.equal(s.stats().find((x) => x.mode === MODE)!.runs, 4);
    assert.doesNotThrow(() => s.restore({} as never));
  });

  test('**起動のときに読めなかったら、読めるまで書かない。読めたら足して書く**', async () => {
    const dir = await tempDir('aas-journal-');
    const path = join(dir, 'idle.json');
    await writeFile(path, JSON.stringify([stat(7, 5000)]));
    const s = idle();
    await loadJournal(s, path, (v) => s.restore(v as never), { read: busy('EPERM') });
    assert.equal(s.stats().find((x) => x.mode === MODE)!.runs, 0);
    s.restore([stat(2, 9000)]); // 空で始めた後に数えた分

    const text = () => JSON.stringify(s.stats());
    assert.equal(await saveJournal(s, path, text, (v) => s.absorb(v), { read: busy('EPERM') }), false);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [stat(7, 5000)], '読めないまま上書きした');

    assert.equal(await saveJournal(s, path, text, (v) => s.absorb(v)), true);
    const saved = (JSON.parse(await readFile(path, 'utf8')) as ReturnType<typeof stat>[]).find((x) => x.mode === MODE)!;
    assert.equal(saved.runs, 9);
    assert.equal(saved.lastRunAt, 9000);

    // 一度読めたら、次からは読み直さずに書く（足し直して倍にしない）
    assert.equal(await saveJournal(s, path, text, (v) => s.absorb(v)), true);
    assert.equal((JSON.parse(await readFile(path, 'utf8')) as ReturnType<typeof stat>[]).find((x) => x.mode === MODE)!.runs, 9);
  });

  test('読めた記録から始めたときは、そのまま書く（対）', async () => {
    const dir = await tempDir('aas-journal-');
    const path = join(dir, 'idle.json');
    await writeFile(path, JSON.stringify([stat(3)]));
    const s = idle();
    await loadJournal(s, path, (v) => s.restore(v as never));
    let absorbed = false;
    assert.equal(await saveJournal(s, path, () => JSON.stringify(s.stats()), () => { absorbed = true; }), true);
    assert.equal(absorbed, false);
    assert.equal((JSON.parse(await readFile(path, 'utf8')) as ReturnType<typeof stat>[]).find((x) => x.mode === MODE)!.runs, 3);
  });

  test('**書くのは一時ファイルから付け替え。残さない。並んで呼んでも壊れない**', async () => {
    const dir = await tempDir('aas-journal-');
    const path = join(dir, 'idle.json');
    const s = idle();
    await Promise.all(Array.from({ length: 5 }, (_, i) =>
      saveJournal(s, path, () => JSON.stringify([stat(i)]), () => undefined)));
    assert.deepEqual(await readdir(dir), ['idle.json']);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [stat(4)]);
  });
});

describe('当番の記録', () => {
  test('**読めなかった後で読めたら、回数を足し、その間に済ませた期を残す**', () => {
    const id = BUILTIN_DUTIES[0]!.id;
    const d = new DutyRoster(BUILTIN_DUTIES);
    const now = Date.now();
    d.complete(id, now);
    const mine = d.records().find((r) => r.dutyId === id)!;
    const period = mine.lastPeriod;
    d.absorb([null, { dutyId: id, completions: 5, missed: 2, lastPeriod: 'old', lastAt: 1 }]);
    const after = d.records().find((r) => r.dutyId === id)!;
    assert.equal(after.completions, 6);
    assert.equal(after.missed, 2);
    assert.equal(after.lastPeriod, period);
    assert.equal(after.lastAt, now);

    const other = BUILTIN_DUTIES[1]!.id;
    d.absorb([{ dutyId: other, completions: 3, missed: 0, lastPeriod: 'p' }]);
    assert.equal(d.records().find((r) => r.dutyId === other)!.lastPeriod, 'p');
  });
});

describe('起動から保存まで（loadJournals → saveJournals）', () => {
  test('**起動のときに読めなかった idle.json は、後で読めたら足して書く。当番の記録は普通に書く**', async () => {
    const dir = await tempDir('aas-journal-');
    const saved = process.env.AAS_STATE_DIR;
    process.env.AAS_STATE_DIR = dir;
    try {
      await mkdir(join(dir, 'idle.json')); // 読めない（EISDIR）
      const j = await loadJournals(DEFAULT_CONFIG);
      j.idle.restore([stat(1)]);
      await rm(join(dir, 'idle.json'), { recursive: true });
      await writeFile(join(dir, 'idle.json'), JSON.stringify([stat(6)]));
      await saveJournals(j);
      const idleSaved = (JSON.parse(await readFile(join(dir, 'idle.json'), 'utf8')) as ReturnType<typeof stat>[]).find((x) => x.mode === MODE)!;
      assert.equal(idleSaved.runs, 7, '読めなかった間の空で上書きした');
      assert.ok(Array.isArray(JSON.parse(await readFile(join(dir, 'duties.json'), 'utf8'))));
      assert.deepEqual((await readdir(dir)).sort(), ['duties.json', 'idle.json']);
    } finally {
      if (saved === undefined) delete process.env.AAS_STATE_DIR; else process.env.AAS_STATE_DIR = saved;
    }
  });
});
