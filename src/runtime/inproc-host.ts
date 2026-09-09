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
 * 使い方: node --experimental-strip-types inproc-host.ts --models-dir <dir> [--port N] [--context-size N] [--lib <path>]
 * 立ち上がると stdout に {"url": "..."} を一行出す。以後、記録は {"log": "..."} で流す。
 */
import { InProcRuntime } from './inproc.ts';
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
  ...(lib ? { load: () => import(pathToFileURL(lib).href).then((m) => (m as { load?: () => Promise<unknown> }).load?.() ?? m) } : {}),
  control: true,
  onLog: (line) => say({ log: line }),
  onExit: () => process.exit(0),
});

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
// 親が消えたら、こちらも終わる。読み込んだモデルを抱えたまま残らない。
process.stdin.on('end', () => stop('親が居なくなった'));
process.stdin.on('close', () => stop('親が居なくなった'));
process.stdin.resume();

const url = await runtime.serve();
say({ url });
