/**
 * 画面を立ち上げる入口。
 * 起動は一手で済ませたいので、待つ・開く・止めるをここに閉じ込める。
 */
import { spawn } from 'node:child_process';
import { loadConfig, ConfigBroken, DEFAULT_CONFIG } from '../config.ts';
import { UiServer, RESTART_EXIT } from '../ui/server.ts';
import { openerFor } from '../core/opener.ts';
import { CannotListen } from '../core/listen.ts';
import { createStopper } from './stop.ts';

/*
 * **設定が壊れていても、画面は開ける。**
 *
 * ここは `loadConfig()` を直に呼んでいたので、`aas.config.json` に末尾の
 * コンマが一つあるだけで、画面はそもそも立ち上がらなかった。**設定を
 * 直しに行く手段まで、同時に塞がる。**モデルが無いと画面じゅうが 500 に
 * なっていたのと同じ形。
 *
 * 既定で開いて、何が壊れているかを出す。直すのは画面の「設定」から。
 */
let config: ReturnType<typeof loadConfig>['config'];
let broken: string | undefined;
try {
  config = loadConfig().config;
} catch (e) {
  if (!(e instanceof ConfigBroken)) throw e;
  broken = e.message;
  config = { ...structuredClone(DEFAULT_CONFIG), runtime: { kind: 'inproc' } };
  console.log(`\n${broken}\n`);
  console.log('  既定のまま開きます。上の場所を直すか、消してください。\n');
}
const port = Number(process.env.AAS_UI_PORT ?? 4174);
// AAS_RELAUNCH は start.cmd が付ける。付いていれば、RESTART_EXIT で終わると
// 起こし直してもらえる。
//
// **付いていないなら、止める道そのものを渡さない。**
// ここまでは、起こし直してもらえない場合でも onRestart を渡していた。
// 「立ち上げ直す」を押すと、返事は `relaunches: false` なのに**プロセスは死ぬ**。
// 誰も起こさないので二度と戻らず、画面には接続できない旨だけが残る。
// 画面を押して回る仕掛けが、この形で実際に落ちた。
const relaunches = process.env.AAS_RELAUNCH === '1';
const server = new UiServer({
  config, port, relaunches,
  ...(relaunches
    ? { onRestart: () => { void server.stop().catch(() => undefined).then(() => process.exit(RESTART_EXIT)); } }
    : {}),
});
/*
 * **口が開けないことは、壊れたことではない。**もう一つ立ち上がっている
 * だけ、ということが多い。ここで受け止めないと、二度押しただけで
 * Node のスタックが出る。理由の一行だけを出して終わる。
 */
let url: string;
try {
  url = await server.start();
} catch (e) {
  if (!(e instanceof CannotListen)) throw e;
  console.log(`\n  ${e.message}\n`);
  process.exit(1);
}

console.log(`  AdaptiveAIStudio — ${url}`);
console.log('  Ctrl-C で終了します。\n');

// 起動はクリックだけで済ませたいので、開くところまでやる。
if (process.env.AAS_UI_NO_OPEN !== '1') {
  const opener = openerFor(process.platform);
  // 開けない環境（サーバ等）でも本体は動かす。
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {
    console.log('  ブラウザを開けませんでした。上の場所を手で開いてください。');
  }).unref();
}

// 起動したら、裏でモデルを読んでおく。最初の送信で数分待たせない。
// 読んでいる間も画面は使える（送りは受け取って、読めたら答える）。
void server.preload().catch(() => undefined);

// 片づけに失敗しても、終わることは終わる。ここで例外を拾わないと、
// **Ctrl-C が効かないまま残る。**
//
// 片づけが終わらなくても、終わる。**上限で諦める。**読み込んだモデルを
// 抱えたまま止まらないと、閉じたつもりの画面の裏で数GBを掴み続ける。
// 何を待っていたかは server.stop が言う。
const STOP_WAIT_MS = 5000;
const stop = createStopper({
  stop: (log) => server.stop(log),
  exit: (code) => process.exit(code),
  log: (line) => console.log(line),
  waitMs: STOP_WAIT_MS,
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
