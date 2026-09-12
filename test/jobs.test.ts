/**
 * 裏で動いているものは、流れではなく「いまの状態」で分かる。
 *
 * 取得の進み具合は 1.5 秒ごとに記録へ流れ、記録が埋まって読めなかった（実機）。
 * 本体は仕事ごとに一つの状態を持ち（/api/jobs）、変わったときに全部を流す（jobs）。
 * 記録（ui.log）には節目だけが残る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

function ggufBody(size = 64 * 1024): Buffer {
  const buf = Buffer.alloc(size);
  buf.write('GGUF');
  return buf;
}

/** 配布元の代わり。ファイルは少しずつ返す（進み具合が何度か来るように）。 */
async function fakeHf() {
  const srv = createServer((req, res) => {
    if (req.url?.startsWith('/api/models/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ siblings: [{ rfilename: 'model-Q4_K_M.gguf' }] }));
    }
    const body = ggufBody();
    res.writeHead(200, { 'content-length': String(body.length) });
    let at = 0;
    const step = () => {
      if (at >= body.length) { res.end(); return; }
      res.write(body.subarray(at, at + 8 * 1024));
      at += 8 * 1024;
      setTimeout(step, 5);
    };
    step();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  return {
    fetchImpl: ((u: string | URL, init?: RequestInit) =>
      fetch(String(u).replace('https://huggingface.co', `http://127.0.0.1:${port}`), init)) as typeof fetch,
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

type Job = { kind: string; id: string; state: string; detail: string; progress?: { pct: number }; startedAt?: string };

describe('裏の仕事', () => {
  test('取得は状態として流れ、記録には節目だけが残る', async () => {
    const { UiServer } = await import('../src/ui/server.ts');
    const { DEFAULT_CONFIG } = await import('../src/config.ts');
    const home = await tempDir('aas-jobs-home-');
    const models = await tempDir('aas-jobs-models-');
    const prev = { home: process.env.AAS_HOME, state: process.env.AAS_STATE_DIR, cfg: process.env.AAS_CONFIG };
    process.env.AAS_HOME = home;
    process.env.AAS_STATE_DIR = join(home, 'state');
    process.env.AAS_CONFIG = join(home, 'aas.config.json');
    const hf = await fakeHf();
    const server = new UiServer({
      port: 0, modelFetch: hf.fetchImpl,
      config: { ...DEFAULT_CONFIG, runtime: { kind: 'inproc', modelsDir: models }, agent: { root: home, approval: 'auto' }, initiative: { enabled: false } } as never,
    });
    const base = (await server.start()).replace(/\/$/, '');
    const ac = new AbortController();
    try {
      // 出来事を読む。
      const events = await fetch(`${base}/api/events`, { signal: ac.signal });
      const reader = events.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); } })().catch(() => undefined);

      const r = await fetch(`${base}/api/models/get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'unsloth/Test-GGUF' }) });
      assert.equal(r.status, 202, await r.text());
      // 終わるまで待つ。
      await until(async () => {
        const { jobs } = await (await fetch(`${base}/api/jobs`)).json() as { jobs: Job[] };
        return jobs.some((j) => j.kind === 'fetch' && j.state !== 'running');
      }, '取得が終わる', { timeoutMs: 30_000 });
      const { jobs } = await (await fetch(`${base}/api/jobs`)).json() as { jobs: Job[] };
      const fetched = jobs.find((j) => j.kind === 'fetch')!;
      assert.equal(fetched.state, 'done', JSON.stringify(fetched));
      assert.match(fetched.detail, /用意できました/);
      assert.ok(fetched.startedAt && !Number.isNaN(Date.parse(fetched.startedAt)), '始めた時刻が無い');

      // 状態の出来事（jobs）が、進み具合（%）付きで流れている。
      await until(() => buf.includes('"type":"jobs"'), 'jobs が流れる');
      const jobEvents = [...buf.matchAll(/data: (\{"type":"jobs".*?\})\n/g)].map((m) => JSON.parse(m[1]!) as { jobs: Job[] });
      assert.ok(jobEvents.some((e) => e.jobs.some((j) => j.kind === 'fetch' && j.progress && j.progress.pct >= 0)), '進み具合が状態として流れていない');
      // 記録（log）には、進み具合の行が流れていない。節目は在る。
      const logTexts = [...buf.matchAll(/data: (\{"type":"log".*?\})\n/g)].map((m) => (JSON.parse(m[1]!) as { text: string }).text);
      assert.ok(logTexts.every((t) => !/\d+%\s+[\d.]+[KMG]?B/.test(t)), `記録に進み具合が流れている: ${logTexts.join(' | ')}`);
      assert.ok(logTexts.some((t) => t.includes('用意できました')), '節目が記録に無い');
      // ファイルの記録も同じ。
      const uiLog = await readFile(join(home, 'state', 'logs', 'ui.log'), 'utf8').catch(() => '');
      assert.ok(!/\d+%\s+[\d.]+[KMG]?B/.test(uiLog), 'ui.log に進み具合が流れている');
      // 取得中の stateChanged は、始まりと終わりの分だけ（1.5 秒ごとに撒かない）。
      const stateChanged = (buf.match(/"type":"stateChanged"/g) ?? []).length;
      assert.ok(stateChanged <= 6, `stateChanged が多すぎる: ${stateChanged}`);
      ac.abort();
      await pump;
    } finally {
      ac.abort();
      await server.stop().catch(() => undefined);
      await hf.close();
      if (prev.home === undefined) delete process.env.AAS_HOME; else process.env.AAS_HOME = prev.home;
      if (prev.state === undefined) delete process.env.AAS_STATE_DIR; else process.env.AAS_STATE_DIR = prev.state;
      if (prev.cfg === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = prev.cfg;
    }
  });

  test('サポート用レポートも裏の仕事として見える（動いている → 出来た）', async () => {
    const { UiServer } = await import('../src/ui/server.ts');
    const { DEFAULT_CONFIG } = await import('../src/config.ts');
    const state = await tempDir('aas-jobs-report-');
    const prev = process.env.AAS_STATE_DIR;
    process.env.AAS_STATE_DIR = state;
    let release!: () => void;
    const gate = new Promise<string>((r) => { release = () => r('報告の中身'); });
    const server = new UiServer({ config: DEFAULT_CONFIG, port: 0, buildReport: () => gate });
    const base = (await server.start()).replace(/\/$/, '');
    try {
      const r = await fetch(`${base}/api/report`, { method: 'POST' });
      assert.ok(r.status === 200 || r.status === 202, `${r.status}`);
      const running = await (await fetch(`${base}/api/jobs`)).json() as { jobs: Job[] };
      assert.equal(running.jobs.find((j) => j.kind === 'report')?.state, 'running');
      release();
      await until(async () => ((await (await fetch(`${base}/api/jobs`)).json()) as { jobs: Job[] }).jobs.find((j) => j.kind === 'report')?.state === 'done', '出来る');
    } finally {
      await server.stop();
      if (prev === undefined) delete process.env.AAS_STATE_DIR; else process.env.AAS_STATE_DIR = prev;
    }
  });
});
