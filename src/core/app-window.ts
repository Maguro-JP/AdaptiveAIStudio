/**
 * 画面を、ブラウザのタブではなくアプリのウィンドウで開く。
 *
 * 実行時の依存はゼロのまま保つ（Electron や WebView の部品を足さない）。
 * Windows には Edge が必ず入っているので、Edge（無ければ Chrome）を `--app` で開く。
 * アドレス欄もタブも無い、一枚のウィンドウになる。
 *
 * 専用の利用者フォルダ（`--user-data-dir`）を渡す。普段のブラウザと分けないと、
 * 既に開いているブラウザに渡されて子がすぐ終わり、ウィンドウを閉じたことが分からない。
 *
 * どこを探すかは、渡された OS と環境で決める（`process.platform` を直に見ない。
 * Linux で走らせている限り Windows の分岐が一度も通らなくなる。`test/app-window.test.ts`）。
 */
import { delimiter, join } from 'node:path';

export interface AppWindowCommand {
  command: string;
  args: string[];
}

/** 探す候補。上から先に使う。 */
export function appBrowserCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter((r): r is string => !!r);
    const out: string[] = [];
    for (const r of roots) out.push(join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    for (const r of roots) out.push(join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    return out;
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  const names = ['microsoft-edge', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  return names.flatMap((n) => dirs.map((d) => join(d, n)));
}

/** 見つかった最初のもの。無ければ undefined（呼ぶ側がブラウザで開く道へ戻る）。 */
export function findAppBrowser(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): string | undefined {
  return appBrowserCandidates(platform, env).find((p) => exists(p));
}

/** アプリのウィンドウとして開く引数。 */
export function appWindowCommand(browser: string, url: string, profileDir: string): AppWindowCommand {
  return {
    command: browser,
    args: [
      `--app=${url}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
    ],
  };
}

/**
 * ウィンドウの子がこれより早く終わったら、閉じたのではなく「既に開いているウィンドウへ渡した」とみなす。
 * そのときは本体を止めない（止めると、開いているウィンドウが繋がらなくなる）。
 */
export const HANDED_OFF_MS = 3_000;
