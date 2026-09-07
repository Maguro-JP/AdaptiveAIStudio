/**
 * 画面を立ち上げる入口。
 * 起動は一手で済ませたいので、待つ・開く・止めるをここに閉じ込める。
 */
import { spawn } from 'node:child_process';
import { loadConfig, ConfigBroken, DEFAULT_CONFIG } from '../config.ts';
import { UiServer, RESTART_EXIT } from '../ui/server.ts';
import { openerFor } from '../core/opener.ts';

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
const url = await server.start();

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

// 片づけに失敗しても、終わることは終わる。ここで例外を拾わないと、
// **Ctrl-C が効かないまま残る。**
const stop = () => { void server.stop().catch(() => undefined).then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
