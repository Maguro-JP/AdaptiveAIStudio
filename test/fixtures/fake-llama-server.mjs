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

// 環境変数で異常系を再現する
if (process.env.FAKE_LLAMA_FAIL === '1') {
  process.stderr.write('error: failed to load model\n');
  process.exit(1);
}
const delayMs = Number(process.env.FAKE_LLAMA_DELAY_MS ?? 0);

const port = Number(get('--port'));
const received = {
  model: get('--model'),
  nGpuLayers: get('--n-gpu-layers'),
  ctxSize: get('--ctx-size'),
  parallel: get('--parallel'),
  cacheTypeK: get('--cache-type-k'),
  mmap: args.includes('--mmap'),
};

const server = createServer((req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'loaded' }], received }));
  }
  res.writeHead(404); res.end();
});

setTimeout(() => {
  server.listen(port, '127.0.0.1', () => process.stderr.write('server listening\n'));
}, delayMs);
