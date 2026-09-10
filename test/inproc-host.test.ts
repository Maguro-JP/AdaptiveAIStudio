/**
 * モデルは別のプロセスで動かす。
 *
 * 同じプロセスで回すと、CPU で数GBを読んでいる間、画面の口まで固まる。
 * 打っても返らず、フリーズにしか見えない（実機でそうなった）。
 * 裏でやることは裏でやる。子は親が消えたら自分で終わる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { InProcHost, hostArgs } from '../src/runtime/inproc-host-client.ts';
import { INPROC_PORT } from '../src/runtime/inproc.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fakeLib = join(here, 'fake-llama-lib.ts');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('別のプロセスで読む', () => {
  test('一覧・読み込み・答え・止める、が子越しに通る', async () => {
    const dir = await tempDir('aas-host-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    const said: string[] = [];
    const host = new InProcHost({ modelsDir: dir, port: 0, lib: fakeLib, onLog: (l) => said.push(l) });
    try {
      assert.deepEqual((await host.list()).map((m) => m.ref), ['a.gguf']);
      // 一覧だけでは子を起こさない（設定の頁を開くたびに待たされないため）。
      assert.equal(host.pid(), undefined, '一覧だけで子を起こしている');
      assert.deepEqual(host.loaded(), []);
      const got = await host.ensureLoaded('a.gguf');
      const pid = host.pid();
      assert.ok(pid && pid !== process.pid, '別のプロセスになっていない');
      assert.deepEqual(host.loaded(), ['a.gguf']);
      assert.ok(said.some((l) => l.includes('読み込みました')), `子の記録が届いていない: ${said.join(' | ')}`);
      // 答えは、子の口へ直に頼む（上の層と同じ道）。
      const r = await fetch(`${got.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'a.gguf', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      });
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.ok(text.includes('別'), `答えが返っていない: ${text.slice(0, 200)}`);
      await host.shutdown();
      assert.ok(pid);
      await until(() => !alive(pid), '子が終わる', { timeoutMs: 8000 });
    } finally {
      await host.shutdown().catch(() => undefined);
    }
  });

  test('**子が途中で死んでも、次の頼みで起こし直す**（落ちたと言い、止めたときは黙る）', async () => {
    const dir = await tempDir('aas-host3-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    const said: string[] = [];
    const host = new InProcHost({ modelsDir: dir, port: 0, lib: fakeLib, onLog: (l) => said.push(l) });
    try {
      await host.ensureLoaded('a.gguf');
      const pid1 = host.pid()!;
      assert.ok(pid1);
      // 記憶が尽きて消えたのと同じ形。こちらは何も知らされない。
      process.kill(pid1, 'SIGKILL');
      await until(() => host.pid() === undefined, '子の終わりに気づく', { timeoutMs: 8000 });
      // 読んだものは消えている、と言えること。送る手前の「空なら読む」がここを見る。
      assert.deepEqual(host.loaded(), [], '落ちたのに読んだままになっている');
      const fell = said.filter((l) => l.startsWith('モデルのプロセスが落ちました'));
      assert.equal(fell.length, 1, `落ちたと言っていない: ${said.join(' | ')}`);
      assert.ok(fell[0]!.includes('次の送信で読み直します'), fell[0]);
      // 次の頼みで、別の子が立って読み直す。
      const got = await host.ensureLoaded('a.gguf');
      const pid2 = host.pid();
      assert.ok(pid2 && pid2 !== pid1, '起こし直していない');
      assert.deepEqual(host.loaded(), ['a.gguf']);
      const r = await fetch(`${got.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'a.gguf', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      });
      assert.equal(r.status, 200);
      assert.ok((await r.text()).includes('別'), '起こし直した子が答えない');
      // こちらから止めたときは、落ちたのではない。言わない。
      await host.shutdown();
      await until(() => !alive(pid2), '子が終わる', { timeoutMs: 8000 });
      assert.equal(said.filter((l) => l.startsWith('モデルのプロセスが落ちました')).length, 1, `止めたのに落ちたと言った: ${said.join(' | ')}`);
    } finally {
      await host.shutdown().catch(() => undefined);
    }
  });

  test('**親が居なくなったら、子は自分で終わる**（親無しで残らない）', async () => {
    const dir = await tempDir('aas-host2-');
    const entry = join(here, '../src/runtime/inproc-host.ts');
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', entry, '--models-dir', dir, '--port', '0', '--lib', fakeLib], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    await new Promise<void>((ok, ng) => {
      const t = setTimeout(() => ng(new Error(`立ち上がらない: ${out}`)), 15000);
      child.stdout.on('data', (b: Buffer) => { out += b; if (out.includes('"url"')) { clearTimeout(t); ok(); } });
    });
    const pid = child.pid!;
    child.stdin.end(); // 親が消えたのと同じ
    await until(() => !alive(pid), '子が終わる', { timeoutMs: 8000 });
  });
});

describe('子に渡す口', () => {
  test('口を渡されなければ、既定の口（繋ぐ側が向いている口）に立てる', () => {
    // 0（空いている口）にしていたので、繋ぐ側と待つ側が別の口になり、
    // 配った形で最初の一言が「接続に失敗」で落ちた。
    const args = hostArgs({ modelsDir: '/m' });
    assert.equal(args[args.indexOf('--port') + 1], String(INPROC_PORT));
    assert.equal(hostArgs({ modelsDir: '/m', port: 5000 })[hostArgs({ modelsDir: '/m', port: 5000 }).indexOf('--port') + 1], '5000');
  });
});
