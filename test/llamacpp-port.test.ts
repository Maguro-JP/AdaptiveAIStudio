/**
 * llama-server を、埋まっている口に起こさない（次の空いた口に起こす）。止めるときは、読み込み中のものも落とす。
 *
 * 埋まっている口に起こすと、起こした方は口を取れずに落ちるが、準備の待ちは先に居る誰か（前に残った
 * llama-server、もう一つの AAS）の返事を「準備できた」と読んでいた。違うモデルが答え、それは止める対象にも入らない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { LlamaCppRuntime } from '../src/runtime/llamacpp.ts';
import { REFERENCE_MACHINE } from '../src/runtime/spec.ts';

const here = join(fileURLToPath(import.meta.url), '..');
const FAKE = join(here, 'fixtures', 'fake-llama-server.mjs');
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((ok) => probe.close(() => ok()));
  return port;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function modelsDir(): Promise<string> {
  const dir = await tempDir('aas-llama-port-');
  await writeFile(join(dir, 'a-7b.gguf'), 'GGUF');
  return dir;
}

describe('llama-server の口', () => {
  test('**口が埋まっていたら、先に居る相手を「準備できた」と読まずに、次の空いた口に起こす**', async () => {
    // 前に残った llama-server の代わり。/models に 200 で答える
    const squatter: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'other-model' }] }));
    });
    await new Promise<void>((ok) => squatter.listen(0, '127.0.0.1', ok));
    const port = (squatter.address() as { port: number }).port;
    const rt = new LlamaCppRuntime({
      command: process.execPath, commandArgs: [FAKE], modelsDir: await modelsDir(),
      machine: REFERENCE_MACHINE, basePort: port, startupTimeoutMs: 15_000,
    });
    try {
      const got = await rt.ensureLoaded('a-7b.gguf');
      assert.notEqual(new URL(got.baseUrl).port, String(port), '埋まっている口を自分のものとして使った');
      assert.equal(rt.loaded().length, 1);
      // 起こした相手が答える（先に居る相手は other-model と答える）
      const res = await fetch(`${got.baseUrl}/models`);
      assert.doesNotMatch(await res.text(), /other-model/);
    } finally {
      await rt.shutdown();
      await new Promise<void>((ok) => squatter.close(() => ok()));
    }
  });

  test('**同じモデルを同時に頼んでも、起こすのは一つ**（二つ起こすと、前の子が止める対象から外れて残っていた）', async () => {
    const rt = new LlamaCppRuntime({
      command: process.execPath, commandArgs: [FAKE], modelsDir: await modelsDir(),
      machine: REFERENCE_MACHINE, basePort: await freePort(), startupTimeoutMs: 15_000,
    });
    try {
      const [a, b] = await Promise.all([rt.ensureLoaded('a-7b.gguf'), rt.ensureLoaded('a-7b.gguf')]);
      assert.equal(a.baseUrl, b.baseUrl);
      assert.equal(rt.loaded().length, 1);
    } finally {
      await rt.shutdown();
    }
  });

  test('読み込み中に止めたら、llama-server を残さない', async () => {
    const lines: string[] = [];
    const rt = new LlamaCppRuntime({
      command: process.execPath, commandArgs: [FAKE], modelsDir: await modelsDir(),
      machine: REFERENCE_MACHINE, basePort: await freePort(), startupTimeoutMs: 600_000,
      onLog: (l) => lines.push(l),
    });
    // 口を開けないまま居続ける代役（読み込みが終わらない llama-server の代わり）
    process.env.FAKE_LLAMA_DELAY_MS = '600000';
    process.env.FAKE_LLAMA_SAY_PID = '1';
    const loading = rt.ensureLoaded('a-7b.gguf').then(() => 'loaded', () => 'rejected');
    let pid = 0;
    try {
      await until(() => lines.some((l) => /^fake-llama pid \d+$/.test(l)), '代役が起きた');
      pid = Number(lines.find((l) => /^fake-llama pid \d+$/.test(l))!.split(' ').at(-1));
      await rt.shutdown();
      await until(() => !alive(pid), '止めたのに、読み込み中の llama-server が残っている', { timeoutMs: 15_000 });
      assert.equal(await loading, 'rejected');
    } finally {
      delete process.env.FAKE_LLAMA_DELAY_MS;
      delete process.env.FAKE_LLAMA_SAY_PID;
      // 落ちたときも代役を残さない（残ると 600 秒待つ作りなので、試験のファイルが終わらない）
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
});
