/**
 * 初めて起こしたとき、モデルが一つも無ければ、推奨のモデルを自分から取りに行く。
 *
 * 帯のボタンを押すまで何も起きなかったので、初めての人は「動かない」と受け取った。
 * 偽の配布元を手元に立てて、起動の道（preload）から取りに行くかを見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

async function fakeHf() {
  let asked = 0;
  const srv = createServer((req, res) => {
    asked += 1;
    if (req.url?.startsWith('/api/models/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ siblings: [{ rfilename: 'model-Q4_K_M.gguf' }] }));
    }
    const body = Buffer.alloc(4096);
    body.write('GGUF');
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  return {
    asked: () => asked,
    fetchImpl: ((u: string | URL, init?: RequestInit) =>
      fetch(String(u).replace('https://huggingface.co', `http://127.0.0.1:${port}`), init)) as typeof fetch,
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

async function boot(models: string, runtime: Record<string, unknown>, hf: Awaited<ReturnType<typeof fakeHf>>) {
  const { UiServer } = await import('../src/ui/server.ts');
  const { DEFAULT_CONFIG } = await import('../src/config.ts');
  const home = await tempDir('aas-autofetch-home-');
  process.env.AAS_HOME = home;
  process.env.AAS_STATE_DIR = join(home, 'state');
  process.env.AAS_CONFIG = join(home, 'aas.config.json');
  const server = new UiServer({
    port: 0,
    modelFetch: hf.fetchImpl,
    config: {
      ...DEFAULT_CONFIG,
      runtime: { kind: 'inproc', modelsDir: models, ...runtime },
      agent: { root: home, approval: 'auto' },
      initiative: { enabled: false },
    } as never,
  });
  await server.start();
  return server;
}

const ggufs = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.gguf'));

test('モデルが一つも無ければ、起動したら推奨のモデルを取ってくる', async () => {
  const hf = await fakeHf();
  const models = await tempDir('aas-autofetch-models-');
  const server = await boot(models, {}, hf);
  try {
    await server.preload();
    await until(async () => (await ggufs(models)).length > 0, '推奨のモデルが置かれる');
    assert.equal((await ggufs(models)).length, 1);
  } finally { await server.stop(); await hf.close(); }
});

test('置いてあるなら取りに行かない（対）', async () => {
  const hf = await fakeHf();
  const models = await tempDir('aas-autofetch-models-');
  await writeFile(join(models, 'mine.gguf'), 'not really');
  const server = await boot(models, {}, hf);
  try {
    await server.preload();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(hf.asked(), 0, '置いてあるのに配布元へ取りに行った');
  } finally { await server.stop(); await hf.close(); }
});

test('autoFetch: false なら取りに行かない（対）', async () => {
  const hf = await fakeHf();
  const models = await tempDir('aas-autofetch-models-');
  const server = await boot(models, { autoFetch: false }, hf);
  try {
    await server.preload();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(hf.asked(), 0);
    assert.deepEqual(await ggufs(models), []);
  } finally { await server.stop(); await hf.close(); }
});
