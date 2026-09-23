/**
 * 通ったときに、**何を確かめていないか**を組み立てる。
 *
 * `npm run check` は「緑」とだけ出していた。緑が意味しているのは
 * 「この機械で・乱数の重みの模型で・Chromium で押した範囲」なのに、
 * 受け取る側にはそれが見えない。**動くと読める。**
 * 実際、Windows で一度も動かしていないものを「確認しました」と出し続けた。
 *
 * 文章で気をつけても、次に書くときには戻る。**`npm run check` の側に言わせる。**
 * 中身は決め打たず、**実際に走った物から組み立てる**（飛ばしたなら、
 * 飛ばしたと出る）。ここを別の物にしてあるのは、**そのものを検査に
 * かけるため**。走らせないと出ない文章は、書いたことにならない。
 */

/**
 * @param {{ platform: string; sweep: 'ran' | string; realModel: boolean }} how
 * @returns {string[]} 確かめていないこと。**必ず一つ以上返る。**
 */
export function notChecked(how) {
  const out = [];
  if (how.platform !== 'win32') {
    out.push(`Windows。ここは ${how.platform} で走らせています。`
      + '配る先は Windows なので、画面もバッチも portable も未確認です。');
  }
  out.push(how.realModel
    ? '本物のモデルの答え。通したのは乱数の重みの模型なので、'
      + '道が繋がっていることしか言えません。答えの中身は見ていません。'
    : '中で読む道。node-llama-cpp が無いので飛ばしました。');
  out.push(how.sweep === 'ran'
    ? '押して回ったのは、この機械の Chromium だけです。'
    : `画面。押して回っていません（${how.sweep}）。`);
  out.push('bundle と setup.exe。ここでは組んでも動かしてもいません。');
  out.push('社用PC の道（Z: から取ってきて、フォルダの node.exe で動かす）。');
  return out;
}

/**
 * 人に見せる形。**報告に、この塊ごと写せるようにする。**
 *
 * `head` は**確かめを始めた時点**の版。終わりに読むと、途中で commit したときに
 * 確かめていない版が書かれる（実際に書かれた）。
 *
 * `dirty` は、その時点で commit していなかった直し。空でないなら、
 * `通りました（sha）` は**その sha そのものの話ではない。**黙って sha だけ出すと、
 * 受け取った側はその commit を確かめたものとして扱う。
 */
export function describeNotChecked(how, head = '', dirty = []) {
  const lines = [`== 通りました${head ? `（${head}）` : ''}`];
  if (dirty.length > 0) {
    lines.push('');
    lines.push(`**commit していない直しが ${dirty.length} 件ある木で確かめました。**`);
    lines.push(`  ${head ? `${head} そのものではありません。` : ''}確かめたのは、この直しを含む木です。`);
    for (const line of dirty.slice(0, 10)) lines.push(`    ${line}`);
    if (dirty.length > 10) lines.push(`    ほか ${dirty.length - 10} 件`);
  }
  lines.push('', '**ここで確かめていないこと**');
  for (const line of notChecked(how)) lines.push(`  ・${line}`);
  lines.push('');
  lines.push('  「通った」は、この一覧の外を保証しません。');
  lines.push('  報告するときは、この一覧ごと写してください。');
  return lines.join('\n');
}

/**
 * 終わりに出すものを、まとめて決める。
 *
 * ここは `check.mjs` の中に直に書いてあった。**走らせないと出ない文章は、
 * 書いたことにならない**ので、判断ごと外に出して、そのものを押せるようにする。
 *
 * @param {{
 *   began: { head: string, dirty: readonly string[] },
 *   ended: { head: string, dirty: readonly string[] },
 *   how: { platform: string, sweep: string, realModel: boolean },
 *   moved?: (before: object, after: object) => (string | undefined),
 * }} arg
 * @returns {{ code: number, text: string }}
 */
export function reportEnd(arg) {
  const { began, ended, how, moved } = arg;
  const why = moved ? moved(began, ended) : undefined;
  // 木が動いていたら、この結果はどちらの木の話か決まらない。通ったと言わない。
  if (why) return { code: 1, text: `== ${why}` };
  return { code: 0, text: describeNotChecked(how, began.head.slice(0, 7), began.dirty) };
}
