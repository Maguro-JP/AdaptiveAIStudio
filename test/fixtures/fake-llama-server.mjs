/**
 * llama-server の代役。テスト用。
 * 実際の llama-server と同じく、引数を受け取り OpenAI互換APIを出す。
 */
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const get = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// 読み込み中に止めたときに残らないことを、試験が番号で見るため
if (process.env.FAKE_LLAMA_SAY_PID === '1') process.stderr.write(`fake-llama pid ${process.pid}\n`);

// 環境変数で異常系を再現する
if (process.env.FAKE_LLAMA_FAIL === '1') {
  process.stderr.write('error: failed to load model\n');
  process.exit(1);
}
const delayMs = Number(process.env.FAKE_LLAMA_DELAY_MS ?? 0);
// 口を開けてから、読み終えるまでの間。この間 `/health` は 503、`/models` は新しい版と同じく 200 を返す
const loadMs = Number(process.env.FAKE_LLAMA_LOAD_MS ?? 0);

/*
 * **知らない引数では、本物と同じく起動ごと落ちる。**どんな引数でも受けていたので、固定の版が知らない `--mmap` を渡していても試験は通っていた。
 * ここに在るのは、固定の版（b4585）が持っていて、こちらが渡しうるものだけ。値を取るものと取らないものを分けて読む
 */
const WITH_VALUE = new Set(['--model', '--port', '--host', '--n-gpu-layers', '--ctx-size', '--parallel', '--cache-type-k', '--cache-type-v', '--threads', '--batch-size']);
const SWITCHES = new Set(['--no-mmap', '--mlock', '--flash-attn', '-fa', '--verbose']);
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (WITH_VALUE.has(a)) { i += 1; continue; }
  if (SWITCHES.has(a)) continue;
  process.stderr.write(`error: invalid argument: ${a}\n`);
  process.exit(1);
}
const flash = args.includes('--flash-attn') || args.includes('-fa');
const cacheV = get('--cache-type-v');
if (cacheV && cacheV !== 'f16' && !flash) {
  // 固定の版は、flash attention 無しで V を下げると context を作れずに終わる
  process.stderr.write('llama_init_from_model: V cache quantization requires flash_attn\n');
  process.exit(1);
}

const port = Number(get('--port'));
const received = {
  model: get('--model'),
  nGpuLayers: get('--n-gpu-layers'),
  ctxSize: get('--ctx-size'),
  parallel: get('--parallel'),
  cacheTypeK: get('--cache-type-k'),
  noMmap: args.includes('--no-mmap'),
  cacheTypeV: cacheV,
  // 付き添い越しに起こしたとき、試験から本体の番号を知るため
  pid: process.pid,
};

let readyAt = Infinity;
const server = createServer((req, res) => {
  if (req.url === '/health') {
    const ok = Date.now() >= readyAt;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(ok ? { status: 'ok' } : { error: { code: 503, message: 'Loading model' } }));
  }
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'loaded' }], received }));
  }
  res.writeHead(404); res.end();
});

setTimeout(() => {
  server.listen(port, '127.0.0.1', () => { readyAt = Date.now() + loadMs; process.stderr.write('server listening\n'); });
}, delayMs);
