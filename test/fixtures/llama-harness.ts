/**
 * llama-server を起こす親の代役（端末の Ctrl-C の試験用）。
 *
 * CLI と同じく、Ctrl-C（SIGINT）では落ちない。模型の llama-server を一つ起こし、その番号と口を一行で出して待つ。
 * 使い方: node --experimental-strip-types llama-harness.ts <modelsDir> <fake-llama-server.mjs> <basePort>
 */
import { LlamaCppRuntime } from '../../src/runtime/llamacpp.ts';
import { REFERENCE_MACHINE } from '../../src/runtime/spec.ts';

const [modelsDir, fake, basePort] = process.argv.slice(2);
process.on('SIGINT', () => { /* 生成だけを止める合図。親は続ける */ });
// 試験が落ちて居なくなったら、こちらも終わる（別のグループなので、残ると llama-server の代役ごと残る）
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.stdin.resume();
const rt = new LlamaCppRuntime({
  command: process.execPath,
  commandArgs: [fake!],
  modelsDir: modelsDir!,
  machine: REFERENCE_MACHINE,
  basePort: Number(basePort),
  startupTimeoutMs: 15_000,
});
const got = await rt.ensureLoaded('a-7b.gguf');
const info = await (await fetch(`${got.baseUrl}/models`)).json() as { received: { pid: number } };
process.stdout.write(`${JSON.stringify({ baseUrl: got.baseUrl, pid: info.received.pid })}\n`);
setInterval(() => undefined, 1 << 30);
