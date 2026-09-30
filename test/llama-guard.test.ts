/**
 * llama-server は、端末の Ctrl-C では止まらず、親が居なくなれば止まる。
 *
 * 端末の Ctrl-C は同じプロセスグループの全員に届く。CLI は Ctrl-C で生成だけを止めて続けるのに、llama-server（外の実行ファイル）は
 * そこで落ちていた。付き添い（`src/runtime/llama-guard.ts`）越しに別のグループで起こし、親が居なくなったら付き添いが止める。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

const here = join(fileURLToPath(import.meta.url), '..');
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('llama-server と端末の Ctrl-C', () => {
  test('親のグループに Ctrl-C が届いても llama-server は答え続け、親が落ちれば止まる', {
    skip: process.platform === 'win32' && 'Windows では付き添いを挟まない（コンソールの Ctrl-C は別の仕組み）',
    timeout: 60_000,
  }, async () => {
    const dir = await tempDir('aas-llama-guard-');
    await writeFile(join(dir, 'a-7b.gguf'), 'GGUF');
    // 親を別のグループの頭にして、端末の Ctrl-C と同じく、そのグループの全員へ SIGINT を送れるようにする
    const parent = spawn(process.execPath, [
      '--experimental-strip-types', '--no-warnings', join(here, 'fixtures', 'llama-harness.ts'),
      dir, join(here, 'fixtures', 'fake-llama-server.mjs'), String(await freePort()),
    ], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let out = '';
    let err = '';
    parent.stdout!.on('data', (b: Buffer) => { out += b.toString(); });
    parent.stderr!.on('data', (b: Buffer) => { err += b.toString(); });
    let pid: number | undefined;
    try {
      await until(() => out.includes('\n'), `親が llama-server を起こせない: ${err}`, { timeoutMs: 30_000, everyMs: 50 });
      const got = JSON.parse(out.split('\n')[0]!) as { baseUrl: string; pid: number };
      pid = got.pid;

      process.kill(-parent.pid!, 'SIGINT');
      // SIGINT で落ちるなら、落ちきるまでの間。下の問い合わせでも見るので、遅い機械で間に合わなくても素通りはしない
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(alive(parent.pid!), '親が Ctrl-C で落ちた（代役の作りが違う）');
      assert.ok(alive(pid), 'Ctrl-C で llama-server が止まった');
      const r = await fetch(`${got.baseUrl}/models`);
      assert.equal(r.status, 200, 'Ctrl-C の後に答えられない');
      await r.text();

      // 親が後始末をせずに消えても、llama-server は残らない
      process.kill(parent.pid!, 'SIGKILL');
      await until(() => !alive(pid!), '親が居なくなっても llama-server が残っている', { timeoutMs: 15_000, everyMs: 100 });
    } finally {
      if (alive(parent.pid!)) process.kill(parent.pid!, 'SIGKILL');
      if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
});
