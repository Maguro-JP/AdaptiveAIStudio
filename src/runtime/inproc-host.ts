/**
 * モデルを動かす、別のプロセスの入口。
 *
 * ここまで、モデルは画面と同じプロセスの中で読んで動かしていた。CPU で
 * 数GBのモデルを回すと、そのプロセスの手が空かず、**画面の口が固まる。**
 * 打っているのに何も返らず、フリーズにしか見えない（実機でそうなった）。
 *
 * 裏でやることは裏でやる。画面のプロセスは、この子へ HTTP で頼むだけにする。
 * 子は親が消えたら（stdin が閉じたら）自分で終わる。親無しで残らない。
 *
 * 使い方: node --experimental-strip-types inproc-host.ts --models-dir <dir> [--port N] [--context-size N] [--sequences N] [--gpu auto|cuda|vulkan|off] [--gpu-seen 0|1] [--lib <path>]
 * 立ち上がると stdout に {"url": "..."} を一行出す。以後、記録は {"log": "..."} で流す。
 */
import { InProcRuntime, type GpuMode } from './inproc.ts';
import { pathToFileURL } from 'node:url';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const modelsDir = arg('--models-dir');
if (!modelsDir) {
  process.stderr.write('--models-dir が要ります\n');
  process.exit(2);
}
const port = Number(arg('--port') ?? '0');
const contextSize = arg('--context-size');
const sequences = arg('--sequences');
const gpu = arg('--gpu');
const gpuSeen = arg('--gpu-seen');
const lib = arg('--lib');

const say = (line: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify(line)}\n`); };

let stopping = false;
const stop = (why: string) => {
  if (stopping) return;
  stopping = true;
  say({ log: `止めます（${why}）` });
  const giveUp = setTimeout(() => process.exit(0), 5000);
  giveUp.unref?.();
  void runtime.shutdown().catch(() => undefined).then(() => process.exit(0));
};

const runtime = new InProcRuntime({
  modelsDir,
  port: Number.isFinite(port) ? port : 0,
  ...(contextSize ? { contextSize: Number(contextSize) } : {}),
  ...(sequences ? { sequences: Number(sequences) } : {}),
  ...(gpu ? { gpu: gpu as GpuMode } : {}),
  ...(gpuSeen ? { gpuSeen: gpuSeen === '1' } : {}),
  ...(lib ? { load: () => import(pathToFileURL(lib).href).then((m) => (m as { load?: () => Promise<unknown> }).load?.() ?? m) } : {}),
  control: true,
  onLog: (line) => say({ log: line }),
  onExit: () => process.exit(0),
});

process.on('SIGTERM', () => stop('SIGTERM'));
/*
 * **SIGINT では止まらない。**端末の Ctrl-C は、同じプロセスグループのこの子にも届く。親（CLI）は Ctrl-C で生成だけを止めて続けるつもり
 * なのに、ここで止まると、モデルを読み直すまで次の依頼が落ちていた。止めるのは親の役目（止める口・SIGTERM）で、親が居なくなれば
 * 標準入力が閉じて、下で終わる。
 */
process.on('SIGINT', () => { /* 親が決める */ });
// 親が消えたら、こちらも終わる。読み込んだモデルを抱えたまま残らない。
process.stdin.on('end', () => stop('親が居なくなった'));
process.stdin.on('close', () => stop('親が居なくなった'));
process.stdin.resume();

const url = await runtime.serve();
say({ url });
