/**
 * 作業前検査の検証。
 * 「毎回流さない」「長すぎたら切り上げる」の2つが要点。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { tempDir, cleanup } from './tmp.ts';
import { join } from 'node:path';
import { BaselineProbe } from '../src/agent/baseline.ts';

async function project(files: Record<string, string>): Promise<string> {
  const root = await tempDir('aas-baseline-');
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  return root;
}

/** 実行のたびに回数を数える。二度目が本当に流れていないかを見るため。 */
const COUNTER = `
import { readFileSync, writeFileSync } from 'node:fs';
const f = new URL('./count.txt', import.meta.url);
let n = 0;
try { n = Number(readFileSync(f, 'utf8').trim()) || 0; } catch {}
writeFileSync(f, String(n + 1));
process.exit(process.env.AAS_FAIL ? 1 : 0);
`;

const SLOW = `
setTimeout(() => process.exit(0), 60_000);
`;

describe('BaselineProbe', () => {
  test('同じ命令なら一度しか流さない', async () => {
    const root = await project({ 'counter.mjs': COUNTER });
    try {
      const probe = new BaselineProbe(root);
      const signal = new AbortController().signal;

      const first = await probe.measure('node counter.mjs', signal);
      const second = await probe.measure('node counter.mjs', signal);

      assert.equal(first.status, 'passed');
      assert.equal(first.cached, false);
      assert.equal(second.status, 'passed');
      assert.equal(second.cached, true);

      const { readFileSync } = await import('node:fs');
      assert.equal(readFileSync(join(root, 'count.txt'), 'utf8').trim(), '1');
    } finally {
      await cleanup(root);
    }
  });

  test('同時に頼まれても二重に流さない', async () => {
    const root = await project({ 'counter.mjs': COUNTER });
    try {
      const probe = new BaselineProbe(root);
      const signal = new AbortController().signal;
      await Promise.all([
        probe.measure('node counter.mjs', signal),
        probe.measure('node counter.mjs', signal),
        probe.measure('node counter.mjs', signal),
      ]);
      const { readFileSync } = await import('node:fs');
      assert.equal(readFileSync(join(root, 'count.txt'), 'utf8').trim(), '1');
    } finally {
      await cleanup(root);
    }
  });

  test('覚えている時間を過ぎたら流し直す', async () => {
    const root = await project({ 'counter.mjs': COUNTER });
    try {
      let now = 0;
      const probe = new BaselineProbe(root, { maxAgeMs: 1000, now: () => now });
      const signal = new AbortController().signal;

      await probe.measure('node counter.mjs', signal);
      now = 5000;
      const again = await probe.measure('node counter.mjs', signal);

      assert.equal(again.cached, false);
      const { readFileSync } = await import('node:fs');
      assert.equal(readFileSync(join(root, 'count.txt'), 'utf8').trim(), '2');
    } finally {
      await cleanup(root);
    }
  });

  test('時間上限を超えたら「分からない」で切り上げ、それも覚える', async () => {
    const root = await project({ 'slow.mjs': SLOW });
    try {
      const probe = new BaselineProbe(root, { timeoutMs: 300 });
      const signal = new AbortController().signal;

      const started = Date.now();
      const outcome = await probe.measure('node slow.mjs', signal);
      const elapsed = Date.now() - started;

      assert.equal(outcome.status, 'unknown');
      assert.equal(outcome.result, undefined, '結果が無いので切り分けには使わない');
      assert.match(outcome.reason ?? '', /切り上げ/);
      assert.ok(elapsed < 30_000, `上限で打ち切られること (${elapsed}ms)`);

      // 二度目は待たされない。毎回同じだけ待つのでは意味がない。
      const again = await probe.measure('node slow.mjs', signal);
      assert.equal(again.cached, true);
      assert.equal(again.status, 'unknown');
    } finally {
      await cleanup(root);
    }
  });

  test('失敗も覚え、結果は切り分けに使える', async () => {
    const root = await project({ 'fail.mjs': 'process.exit(1);' });
    try {
      const probe = new BaselineProbe(root);
      const signal = new AbortController().signal;
      const outcome = await probe.measure('node fail.mjs', signal);
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.result?.passed, false);
      assert.equal((await probe.measure('node fail.mjs', signal)).cached, true);
    } finally {
      await cleanup(root);
    }
  });

  test('捨てれば流し直す', async () => {
    const root = await project({ 'counter.mjs': COUNTER });
    try {
      const probe = new BaselineProbe(root);
      const signal = new AbortController().signal;
      await probe.measure('node counter.mjs', signal);
      assert.notEqual(probe.remembered('node counter.mjs'), undefined);
      probe.invalidate();
      assert.equal(probe.remembered('node counter.mjs'), undefined);
      assert.equal((await probe.measure('node counter.mjs', signal)).cached, false);
    } finally {
      await cleanup(root);
    }
  });
});
