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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('止めたら止まる', () => {
  test('入口は、片づけを待つのに上限を置いている', () => {
    const src = readFileSync(join(root, 'src/cli/ui.ts'), 'utf8');
    assert.ok(/STOP_WAIT_MS\s*=\s*\d+/.test(src), '上限が無い');
    const stop = src.slice(src.indexOf('const stop = '));
    assert.ok(/setTimeout\(/.test(stop) && /process\.exit\(0\)/.test(stop), '上限で終わっていない');
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
