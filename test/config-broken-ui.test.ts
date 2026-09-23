/**
 * 設定が食い違っていても、画面は開く。そして**そう言う**。
 *
 * 書き間違い（JSON の形）は前から画面を開ける作りだった。**中身の食い違い
 * （providers が空、など）だけが、立ち上がりごと止めていた。**理由は端末にしか
 * 出ないので、`start.cmd` から起こした人には何も分からない（端末は隠れている）。
 *
 * ここは入口ごと動かして見る。壊れた設定で `src/cli/ui.ts` を起こし、
 * 画面が開くこと、`/api/ready` が理由を返すことまで。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { ConfigBroken, parseConfigText } from '../src/config.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 空いている番号を一つ借りる（借りたらすぐ返す）。 */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('食い違った設定', () => {
  test('**中身の食い違いも、直せる形で断る**', async () => {
    const { loadConfig } = await import('../src/config.ts');
    const home = await tempDir('aas-cfg-broken-');
    const at = join(home, 'aas.config.json');
    await writeFile(at, JSON.stringify({ providers: [], candidates: ['x:y'] }));
    const before = process.env.AAS_CONFIG;
    process.env.AAS_CONFIG = at;
    try {
      assert.throws(() => loadConfig(), (e: unknown) => {
        assert.ok(e instanceof ConfigBroken, `直せる形で断っていない: ${String(e)}`);
        return true;
      });
    } finally {
      if (before === undefined) delete process.env.AAS_CONFIG;
      else process.env.AAS_CONFIG = before;
    }
  });

  test('書き間違い（JSON の形）も、これまでどおり（対）', () => {
    assert.throws(() => parseConfigText('{ "providers": [ ', '/どこか/aas.config.json'),
      (e: unknown) => e instanceof ConfigBroken);
  });

  test('**壊れた設定でも画面は開き、理由を返す**', async () => {
    const home = await tempDir('aas-cfg-ui-');
    await mkdir(home, { recursive: true });
    const at = join(home, 'aas.config.json');
    /*
     * 知らない繋ぎ方を書いた設定。これまでは、ここで立ち上がりごと止まっていた。
     *
     * **`providers: []` では止まらない。**この中で読む（既定）のときは、
     * 繋ぎ先をこちらで足すので、空でも通る（`wireInProc`）。試す側で一度外した。
     */
    await writeFile(at, JSON.stringify({ providers: [{ id: 'p', kind: 'weird', baseUrl: 'http://127.0.0.1:1' }] }));
    const port = await freePort();
    const ui = spawn(process.execPath, [join(root, 'src', 'cli', 'ui.ts')], {
      env: {
        ...process.env,
        AAS_HOME: home, AAS_STATE_DIR: join(home, 'state'), AAS_CONFIG: at,
        AAS_UI_PORT: String(port), AAS_NO_OPEN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let said = '';
    ui.stdout?.on('data', (c) => { said += c; });
    ui.stderr?.on('data', (c) => { said += c; });
    try {
      let ready: { ready?: boolean; configProblem?: string } | undefined;
      await until(async () => {
        ready = await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: AbortSignal.timeout(2000) })
          .then((r) => r.json() as Promise<{ ready?: boolean; configProblem?: string }>)
          .catch(() => undefined);
        return ready !== undefined;
      }, `壊れた設定でも画面が開く（言ったこと: ${''}）`, { timeoutMs: 30_000 });
      assert.match(ready?.configProblem ?? '', /未対応の provider kind/,
        `何が読めなかったのかを、画面へ返していない: ${JSON.stringify(ready)} / ${said.slice(0, 300)}`);
    } finally {
      ui.kill();
    }
  });
});
