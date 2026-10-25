/**
 * 画面を立ち上げる入口。
 * 起動は一手で済ませたいので、待つ・開く・止めるをここに閉じ込める。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../core/home.ts';
import { loadConfig, ConfigBroken, DEFAULT_CONFIG } from '../config.ts';
import { UiServer, RESTART_EXIT } from '../ui/server.ts';
import { openerFor } from '../core/opener.ts';
import { findAppBrowser, appWindowCommand, HANDED_OFF_MS } from '../core/app-window.ts';
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
  console.log('  既定のまま開きます。上の案内に従ってください（名前を変えるときも、消さなければ中身は残ります）。\n');
}
// 口の番号は 0〜65535 の整数だけ受ける（0 は空いている口に任せる）。数でないと Node の誤りで落ち、スタックだけが出ていた
const askedPort = process.env.AAS_UI_PORT;
const portOk = askedPort !== undefined && /^\d+$/.test(askedPort.trim()) && Number(askedPort) <= 65535;
const port = portOk ? Number(askedPort) : 4174;
if (askedPort !== undefined && !portOk) {
  console.log(`  AAS_UI_PORT=${askedPort} は口の番号として読めないので、4174 で開きます（0〜65535 の整数で書いてください）。\n`);
}
// AAS_RELAUNCH は start.cmd が付ける。付いていれば、RESTART_EXIT で終わると
// 起こし直してもらえる。
//
// **付いていないなら、止める道そのものを渡さない。**
// ここまでは、起こし直してもらえない場合でも onRestart を渡していた。
// 「立ち上げ直す」を押すと、返事は `relaunches: false` なのに**プロセスは死ぬ**。
// 誰も起こさないので二度と戻らず、画面には接続できない旨だけが残る。
// 画面を押して回る仕掛けが、この形で実際に落ちた。
/*
 * 画面を開く。アプリのウィンドウ（Edge か Chrome の --app）。どちらも無い機械だけ、ブラウザのタブで開く。
 * **閉じても本体は止めない。**裏で動き続け、次に開くとすぐ使える（読み込んだモデルもそのまま）。
 * 止めるのは画面のコマンドの「終了」（/api/quit）か、このコンソールの Ctrl-C。
 */
function openWindow(url: string): void {
  if (process.env.AAS_UI_NO_OPEN === '1') return;
  const browser = findAppBrowser(process.platform, process.env, existsSync);
  if (browser) {
    const { command, args } = appWindowCommand(browser, url, join(stateDir(), 'window'));
    const openedAt = Date.now();
    const win = spawn(command, args, { stdio: 'ignore' });
    win.on('error', () => console.log('  ウィンドウを開けませんでした。上の場所を手で開いてください。'));
    win.on('exit', () => {
      if (Date.now() - openedAt < HANDED_OFF_MS) return; // 既に開いているウィンドウへ渡した
      console.log('  ウィンドウを閉じました。本体は裏で動き続けます（終わるときは画面のコマンドの「終了」か、ここで Ctrl-C）。');
    });
    return;
  }
  const opener = openerFor(process.platform);
  console.log('  アプリのウィンドウを開く部品（Edge か Chrome）が見つからないので、ブラウザで開きます。');
  // 開けない環境（サーバ等）でも本体は動かす。
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {
    console.log('  ブラウザを開けませんでした。上の場所を手で開いてください。');
  }).unref();
}

/*
 * もう裏で動いているなら、新しく立てずにウィンドウだけ開き直す。
 * 同じ口に別のものが居るときは開き直さない（/api/info の app で見分ける）。
 */
if (port !== 0) {
  const running = `http://127.0.0.1:${port}/`;
  const info = await fetch(`${running}api/info`, { signal: AbortSignal.timeout(1500) })
    .then((r) => (r.ok ? r.json() as Promise<{ app?: string }> : undefined)).catch(() => undefined);
  if (info?.app === 'AdaptiveAIStudio') {
    console.log(`  裏で動いている AdaptiveAIStudio のウィンドウを開きます — ${running}`);
    openWindow(running);
    // 子（ウィンドウ）を手放してから終わる。待つと、ウィンドウを閉じるまでこのコンソールが残る
    setTimeout(() => process.exit(0), 500);
    await new Promise(() => undefined);
  }
}

const relaunches = process.env.AAS_RELAUNCH === '1';
const server = new UiServer({
  config, port, relaunches,
  /*
   * **端末にだけ出しても、読まれない。**start.cmd から起こすと、その端末は
   * 裏に隠れる（Windows では閉じていることもある）。設定が読めなかったことは
   * 画面にも出す。直すのは画面の「設定」からなので、そこに出ていないと辿れない。
   */
  ...(broken ? { configProblem: broken } : {}),
  ...(relaunches
    ? { onRestart: () => { void server.stop().catch(() => undefined).then(() => process.exit(RESTART_EXIT)); } }
    : {}),
  onQuit: () => { onQuitAsked?.(); },
});
let onQuitAsked: (() => void) | undefined;
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
openWindow(url);

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
onQuitAsked = stop;
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
