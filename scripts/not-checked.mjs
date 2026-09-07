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

/** 人に見せる形。**報告に、この塊ごと写せるようにする。** */
export function describeNotChecked(how, head = '') {
  const lines = [`== 通りました${head ? `（${head}）` : ''}`, '', '**ここで確かめていないこと**'];
  for (const line of notChecked(how)) lines.push(`  ・${line}`);
  lines.push('');
  lines.push('  「通った」は、この一覧の外を保証しません。');
  lines.push('  報告するときは、この一覧ごと写してください。');
  return lines.join('\n');
}
