/**
 * 1ターンの結末の一行。
 *
 * 「完了 · 182.3秒」とだけ出ていた。**遅かった理由が、どこにも無い。**
 * どのモデルが答えて、どれだけの速さだったかを同じ行に出す。
 * 遅ければ（3 tok/s 未満）、その場で「モデルが大きすぎる」と言う。
 * 設定の奥に数字はあったが、そこを開く人はいない。
 */
const SLOW_TPS = 3;

/*
 * 終わり方の符丁を、人の言葉に引き直す。
 *
 * **`noProgress` がそのまま画面に出ていた**（実機の画面で見た）。
 * 符丁は機械が読むためのもので、打った人に見せるものではない。
 * 見せられた側は、何が起きたのかも、次に何をすればいいのかも分からない。
 *
 * 決まりは CLAUDE.md の「外は利用者の語、中は機械が読みやすい形」。
 * 中は符丁のまま持ち、**出すときに引き直す**。
 */
const WHY = {
  maxTurns: '打ち切りました（往復の上限に届きました）',
  noProgress: '進みませんでした',
  aborted: '止めました',
  failed: '落ちました',
  rejected: '断られました',
  error: '落ちました',
};

function howText(v) {
  // 知らない符丁でも、符丁のままは出さない。ただし隠さない（送ってもらうため添える）。
  if (v.reason !== 'completed') return WHY[v.reason] ?? `終わりました（${v.reason}）`;
  /*
   * **訊かれただけの回に、作業の言葉を着せない。**
   *
   * 「明日の天気は？」に「完了（検証していません）」と出していた。
   * 何も完了していないし、確かめるものも無い（実機の画面で見た）。
   */
  if (v.chat) return '答えました';
  if (v.checked === 'passed') return '完了（検証を通りました）';
  if (v.checked === 'failed') return '完了（検証は通っていません）';
  if (v.checked === 'preexisting') return '完了（元から落ちています）';
  return '完了（検証していません）';
}

/** 結末の一行。速さが測れた回だけ、速さも添える。 */
function verdictText(v) {
  const parts = [howText(v), `${v.seconds.toFixed(1)}秒`];
  if (v.model) parts.push(v.model);
  if (typeof v.tps === 'number') parts.push(`約 ${v.tps} tok/s`);
  return parts.join(' · ');
}

/** 遅かったときだけ、理由の一行。測れていないときは何も言わない。 */
function slowNote(v) {
  if (typeof v.tps !== 'number' || v.tps >= SLOW_TPS) return '';
  return `遅いです（約 ${v.tps} tok/s）。このモデルはこの機械には大きすぎるかもしれません。`
    + '設定で小さいモデルを選ぶと速くなります。';
}

export { SLOW_TPS, howText, verdictText, slowNote };
