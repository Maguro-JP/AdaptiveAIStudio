/**
 * 画面を立ち上げる入口。
 * 起動は一手で済ませたいので、待つ・開く・止めるをここに閉じ込める。
 */
import { spawn } from 'node:child_process';
import { loadConfig } from '../config.ts';
import { UiServer, RESTART_EXIT } from '../ui/server.ts';

const { config } = loadConfig();
const port = Number(process.env.AAS_UI_PORT ?? 4174);
// AAS_RELAUNCH は start.cmd が付ける。付いていれば、RESTART_EXIT で終わると
// 起こし直してもらえる。付いていなければ、終わるだけ（画面がそう案内する）。
const relaunches = process.env.AAS_RELAUNCH === '1';
const server = new UiServer({
  config, port, relaunches,
  onRestart: () => { void server.stop().then(() => process.exit(RESTART_EXIT)); },
});
const url = await server.start();

console.log(`  AdaptiveAIStudio — ${url}`);
console.log('  Ctrl-C で終了します。\n');

// 起動はクリックだけで済ませたいので、開くところまでやる。
if (process.env.AAS_UI_NO_OPEN !== '1') {
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  // 開けない環境（サーバ等）でも本体は動かす。
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {
    console.log('  ブラウザを開けませんでした。上の場所を手で開いてください。');
  }).unref();
}

const stop = () => { void server.stop().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
