/**
 * llama-server の付き添い。親（画面・CLI）と llama-server の間に一枚挟む。
 *
 * 端末の Ctrl-C は、同じプロセスグループの全員に届く。CLI は Ctrl-C で生成だけを止めて続けるつもりなのに、
 * llama-server は外の実行ファイルで SIGINT を受け流せないので、そこで落ちていた（次の依頼は、モデルを読み直すまで落ちる）。
 * 親はこの付き添いを別のプロセスグループで起こす（`detached`）。llama-server はこの付き添いのグループに入るので、
 * 端末の Ctrl-C は届かない。
 *
 * 別のグループにすると、端末を閉じたとき・親が落ちたときにも止まらなくなる。数GBを抱えたまま残らないよう、
 * 親が居なくなったら（標準入力が閉じたら）llama-server を止めて終わる。止めるのは親の役目（SIGTERM）でもできる。
 *
 * 使い方: node --experimental-strip-types llama-guard.ts <command> [args...]
 * llama-server の出力はそのまま親へ流す。終了コードは llama-server のものを返す。
 */
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('llama-guard: 起こすものが指定されていません\n');
  process.exit(2);
}

// windowsHide: 付き添いはコンソールを持たない（detached）。そのまま起こすと、llama-server にコンソールのウィンドウが一つ開く
const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });

const alive = (): boolean => child.exitCode === null && child.signalCode === null;
const stop = (): void => {
  if (!alive()) return;
  child.kill('SIGTERM');
  // 止まらなければ落とす（VRAM を抱えたまま残らない）
  const hard = setTimeout(() => { if (alive()) child.kill('SIGKILL'); }, 5000);
  hard.unref?.();
};

child.on('error', (e) => {
  // 起こせなかった（実行ファイルが無い等）。親は出力の末尾から見立てるので、理由をそのまま流す。
  // 書き終えてから終わる（管への書き込みが非同期の所では、すぐ終わると理由が消える）
  process.stderr.write(`${e.message}\n`, () => process.exit(127));
});
child.on('exit', (code, signal) => {
  if (code !== null) process.exit(code);
  // シグナルで落ちたなら、同じシグナルで落ちる（終了コード 1 にすると、llama-server が自分で失敗したように見える）
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(1);
});

process.on('SIGTERM', stop);
// 端末の Ctrl-C は受け流す（止めるのは親が決める）
process.on('SIGINT', () => { /* 親が決める */ });
process.on('SIGHUP', () => { /* 端末が閉じても、親が居る間は続ける。親が居なくなれば下で止まる */ });
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
