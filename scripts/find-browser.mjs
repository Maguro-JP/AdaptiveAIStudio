/**
 * 押して回るための、ブラウザを探す。
 *
 * ここは `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` を決め打って
 * いた。**この機械にしか無い道。**Windows で `npm run check` を回すと、
 * 押して回る部分だけが静かに飛ぶ。つまり**配る先で回したときに限って、
 * いちばん壊れやすい所を見ない**ことになる。
 *
 * Windows には Edge が必ず入っている。Chrome も多い。探せばよい。
 *
 * OS の枝は、**この機械で試せる形にする**（`src/core/opener.ts` と同じ）。
 * `process.platform` を関数の中で直に見ない。渡してもらう。
 */

/**
 * 探す先。**上から順に。**
 *
 * @param {string} platform `process.platform`
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function browserCandidates(platform, env = {}) {
  if (platform === 'win32') {
    const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = env['LOCALAPPDATA'] ?? '';
    return [
      // Edge は Windows に必ず入っている。**まずこれ。**
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      ...(local ? [`${local}\\Google\\Chrome\\Application\\chrome.exe`] : []),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return [
    // この機械（開発の容れ物）に置いてあるもの。
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
}

/**
 * 実際に在るものを一つ選ぶ。
 *
 * `AAS_SWEEP_BROWSER` が指定されていれば、**それだけを見る**
 * （指定したのに黙って別のものを使われる方が困る）。
 *
 * @param {{ platform: string; env?: Record<string, string | undefined>; exists: (p: string) => boolean }} how
 * @returns {{ ok: true; browser: string } | { ok: false; why: string }}
 */
export function findBrowser(how) {
  const env = how.env ?? {};
  const named = env['AAS_SWEEP_BROWSER'];
  if (named) {
    return how.exists(named)
      ? { ok: true, browser: named }
      : { ok: false, why: `AAS_SWEEP_BROWSER が指すものがありません: ${named}` };
  }
  const tried = browserCandidates(how.platform, env);
  for (const at of tried) {
    if (how.exists(at)) return { ok: true, browser: at };
  }
  // **どこを見たかまで言う。**「ありません」だけだと、次に何をすればいいか分からない。
  return {
    ok: false,
    why: `ブラウザが見つかりません（見た先: ${tried.join(' / ')}）`
      + '。AAS_SWEEP_BROWSER に場所を渡せば、それを使います',
  };
}
