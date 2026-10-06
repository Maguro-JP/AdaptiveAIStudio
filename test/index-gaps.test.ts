/**
 * コードを探す・repo map を作る・作業前の確かめを覚える所の不具合（52 回目の調査）。
 *
 * - 何も変わっていなくても索引の作った時刻を毎回付け直し、repo map の使い回しが当たらず、依頼のたびに repo map が変わった
 * - 大きなファイルの 200 個目より後の名前が索引に入らず、find_symbol が黙って「無い」と言った
 * - 版の違う索引を使い回し、直す前の拾い方の中身が残った
 * - 時計が戻ると、戻った分だけ古い索引を返し続けた
 * - 別の会話の ■ で止められた作業前の確かめを、「作業前から落ちていた」として受け取った。待つ間に自分の ■ が効かなかった
 * - 本文に OpenAI の形のまま書かれたツール呼び出しを拾えなかった
 * - 索引のファイルが片づけの対象に無かった
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { buildIndex, lookupSymbol, IndexStore, INDEX_FORMAT } from '../src/agent/code-index.ts';
import { BaselineProbe } from '../src/agent/baseline.ts';
import { toCall } from '../src/agent/tool-text.ts';

describe('コードの索引', () => {
  test('**何も変わっていなければ、作った時刻を引き継ぐ**', async () => {
    const root = await tempDir('aas-index-gaps-same-');
    await writeFile(join(root, 'a.ts'), 'export function alpha() {}\n');
    const first = await buildIndex(root);
    await new Promise((r) => setTimeout(r, 20));
    const second = await buildIndex(root, undefined, first);
    assert.equal(second.builtAt, first.builtAt, '何も変わっていないのに作り直したことにした');
    await writeFile(join(root, 'b.ts'), 'export function beta() {}\n');
    const third = await buildIndex(root, undefined, second);
    assert.notEqual(third.builtAt, second.builtAt, '増えたのに同じ時刻のまま');
  });

  test('**大きなファイルの末尾の宣言も、find_symbol で見つかる**', async () => {
    const root = await tempDir('aas-index-gaps-big-');
    const inner = Array.from({ length: 300 }, (_, i) => `  const local${i} = ${i};`).join('\n');
    await writeFile(join(root, 'big.ts'), `export function head() {\n${inner}\n}\n\nexport function tailEnd() { return 1; }\n`);
    const index = await buildIndex(root);
    assert.equal(lookupSymbol(index, 'tailEnd').defined.length, 1, '末尾の宣言が索引に入っていない');
  });

  test('**作り方の版の違う索引は使い回さない**', async () => {
    const root = await tempDir('aas-index-gaps-format-');
    await writeFile(join(root, 'a.ts'), 'export function alpha() {}\n');
    const store = new IndexStore(await tempDir('aas-index-gaps-store-'));
    const made = await buildIndex(root);
    assert.equal(made.format, INDEX_FORMAT);
    await store.save({ ...made, format: undefined });
    assert.equal(await store.load(root), undefined, '版の無い索引を使い回した');
    await store.save(made);
    assert.ok(await store.load(root));
  });

  test('**時計が戻っても、古い索引を返し続けない**', async () => {
    const root = await tempDir('aas-index-gaps-clock-');
    await writeFile(join(root, 'a.ts'), 'export function alpha() {}\n');
    const store = new IndexStore(await tempDir('aas-index-gaps-store-'));
    // 作った時刻は実際の時計で付くので、比べる時刻も実際の時計から決める（離れた時刻にすると、戻った形にならない）
    const t = Date.now();
    await store.fresh(root, 1500, t);
    await writeFile(join(root, 'b.ts'), 'export function beta() {}\n');
    // 時計が 1 時間戻った
    const after = await store.fresh(root, 1500, t - 3_600_000);
    assert.equal(lookupSymbol(after, 'beta').defined.length, 1, '時計が戻った分だけ古い索引を返した');
  });
});

describe('作業前の確かめ', () => {
  test('**別の会話が止めた回を、作業前から落ちていたとして受け取らない**', { timeout: 30_000 }, async () => {
    const root = await tempDir('aas-index-gaps-baseline-');
    await writeFile(join(root, 'slow.mjs'), 'setTimeout(() => process.exit(0), 800);\n');
    const probe = new BaselineProbe(root);
    const command = `"${process.execPath}" slow.mjs`;
    const a = new AbortController();
    const first = probe.measure(command, a.signal);
    const second = probe.measure(command, new AbortController().signal);
    setTimeout(() => a.abort(), 200);
    const [mine, theirs] = await Promise.all([first, second]);
    assert.equal(mine.status, 'unknown', `止めた回を${mine.status}とした`);
    assert.equal(theirs.status, 'passed', `相手の止めた回を受け取った: ${theirs.status} ${theirs.reason ?? ''}`);
  });

  test('**待っている間も、自分の ■ ですぐやめる**', { timeout: 30_000 }, async () => {
    const root = await tempDir('aas-index-gaps-baseline-wait-');
    await writeFile(join(root, 'slow.mjs'), 'setTimeout(() => process.exit(0), 3000);\n');
    const probe = new BaselineProbe(root);
    const command = `"${process.execPath}" slow.mjs`;
    const owner = probe.measure(command, new AbortController().signal);
    const b = new AbortController();
    const began = Date.now();
    const waiting = probe.measure(command, b.signal);
    setTimeout(() => b.abort(), 100);
    const got = await waiting;
    assert.ok(Date.now() - began < 2000, `自分の ■ が効かず、相手が終わるまで待った（${Date.now() - began}ms）`);
    assert.equal(got.status, 'unknown');
    await owner;
  });
});

describe('本文に書かれたツール呼び出し', () => {
  test('**OpenAI の形のまま書いたものも拾う**', () => {
    const got = toCall({ type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } });
    assert.deepEqual(got, { name: 'read_file', args: { path: 'a.ts' } });
  });
});

describe('片づけ', () => {
  test('**もう無い作業場のコードの索引を挙げる**', async () => {
    const home = await tempDir('aas-index-gaps-clean-');
    const before = { home: process.env.AAS_HOME, state: process.env.AAS_STATE_DIR, bin: process.env.AAS_BIN_DIR, models: process.env.AAS_MODELS_DIR };
    process.env.AAS_HOME = home;
    delete process.env.AAS_STATE_DIR; delete process.env.AAS_BIN_DIR; delete process.env.AAS_MODELS_DIR;
    try {
      const { findRemovable } = await import('../src/runtime/cleanup.ts');
      const { stateDir } = await import('../src/core/home.ts');
      const root = await tempDir('aas-index-gaps-cleanroot-');
      await writeFile(join(root, 'a.ts'), 'export function alpha() {}\n');
      const store = new IndexStore(join(stateDir(), 'index'));
      await mkdir(join(stateDir(), 'index'), { recursive: true });
      await store.save(await buildIndex(root));
      const kept = await findRemovable({ keepTag: 'b9999' });
      assert.equal(kept.some((f) => f.path.includes(`${join('index', '')}`)), false, 'まだ在る作業場の索引を挙げた');
      await rm(root, { recursive: true, force: true });
      const found = await findRemovable({ keepTag: 'b9999' });
      assert.ok(found.some((f) => /もう無い作業場/.test(f.why)), `もう無い作業場の索引を挙げていない: ${found.map((f) => f.why).join(' / ')}`);
    } finally {
      for (const [k, v] of [['AAS_HOME', before.home], ['AAS_STATE_DIR', before.state], ['AAS_BIN_DIR', before.bin], ['AAS_MODELS_DIR', before.models]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
