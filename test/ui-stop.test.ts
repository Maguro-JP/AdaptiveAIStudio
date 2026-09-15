/**
 * 止めたら、止まる。
 *
 * Ctrl-C で server.stop() を待ってから終わっていた。片づけのどこかが
 * 返ってこないと、**閉じたつもりの画面の裏で、読み込んだモデルごと
 * 生き続ける**（check:bundle が最後で固まって見つけた）。上限で諦める。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UiServer } from '../src/ui/server.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createStopper } from '../src/cli/stop.ts';
import { until } from './until.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('止めたら止まる', () => {
  /**
   * ここは入口の文字を見ていた（`setTimeout` と `process.exit` が在るか）。
   * **字が在ることは、押したときに終わることを言わない。**動かして見る。
   */
  test('**返ってこない片づけでも、上限で終わる**', async () => {
    const said: string[] = [];
    const exited: number[] = [];
    const stop = createStopper({
      // 返ってこない片づけ。読み込んだモデルを抱えたまま固まった形。
      stop: () => new Promise(() => undefined),
      exit: (code) => exited.push(code),
      log: (l) => said.push(l),
      waitMs: 30,
    });
    stop();
    await until(() => exited.length > 0, '上限で終わる', { timeoutMs: 5000 });
    assert.deepEqual(exited, [0]);
    assert.ok(said.some((l) => l.includes('0.03 秒で終わらない')), said.join(' | '));
  });

  test('片づけが終われば、そこで終わる（上限は取り下げる）', async () => {
    const said: string[] = [];
    const exited: number[] = [];
    // **上限を短くしておく。**長い上限で置くと、取り下げ（clearTimeout）を
    // 外しても時計が鳴らないので、この試験は何も見ていないことになる
    // （実際に 60 秒で書いて、外しても通った）。
    const stop = createStopper({
      stop: (log) => { log('残っていたものを片づけました'); return Promise.resolve(); },
      exit: (code) => exited.push(code),
      log: (l) => said.push(l),
      waitMs: 40,
    });
    stop();
    await until(() => exited.length > 0, '片づけの後に終わる', { timeoutMs: 5000 });
    assert.deepEqual(exited, [0]);
    assert.ok(said.some((l) => l.includes('残っていたものを片づけました')), said.join(' | '));
    // 上限を過ぎるまで待つ。取り下げていれば、ここで何も起きない。
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(exited, [0], '二度終わらせている');
    assert.ok(!said.some((l) => l.includes('終わらないので')), `終わったのに上限が鳴った: ${said.join(' | ')}`);
  });

  test('片づけが投げても、終わる', async () => {
    const exited: number[] = [];
    const stop = createStopper({
      stop: () => Promise.reject(new Error('片づけで落ちた')),
      exit: (code) => exited.push(code),
      log: () => undefined,
      waitMs: 60_000,
    });
    stop();
    await until(() => exited.length > 0, '投げても終わる', { timeoutMs: 5000 });
    assert.deepEqual(exited, [0]);
  });

  test('二度押されたら、待たずに終わる', async () => {
    const said: string[] = [];
    const exited: number[] = [];
    const stop = createStopper({
      stop: () => new Promise(() => undefined),
      exit: (code) => exited.push(code),
      log: (l) => said.push(l),
      waitMs: 60_000,
    });
    stop();
    assert.deepEqual(exited, [], '一度目で終わっている');
    stop();
    assert.deepEqual(exited, [0], '二度目で終わっていない');
    assert.ok(said.some((l) => l.includes('もう一度押された')), said.join(' | '));
  });

  test('入口は、この段取りを使っている', () => {
    // 段取りを外に出した意味が無くならないよう、入口が使っていることも見る。
    const src = readFileSync(join(root, 'src/cli/ui.ts'), 'utf8');
    assert.ok(src.includes('createStopper('), '入口が使っていない');
  });

  test('stop は、時間のかかった段の名前を言う', async () => {
    const server = new UiServer({ port: 0, config: { ...DEFAULT_CONFIG, runtime: { kind: 'ollama' } } as typeof DEFAULT_CONFIG });
    await server.start();
    const said: string[] = [];
    // 何も抱えていなければ、何も言わずにすぐ終わる。
    const began = Date.now();
    await server.stop((l) => said.push(l));
    assert.ok(Date.now() - began < 2000, '何も抱えていないのに時間がかかる');
    assert.deepEqual(said, []);
  });
});
