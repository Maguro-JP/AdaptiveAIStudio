/**
 * 1ターンの結末の一行。
 *
 * 「完了 · 182.3秒」とだけ出ていた。**遅かった理由が、どこにも無い。**
 * どのモデルが答えて、どれだけの速さだったかを同じ行に出す。
 * 遅ければ（3 tok/s 未満）、その場で「モデルが大きすぎる」と言う。
 * 設定の奥に数字はあったが、そこを開く人はいない。
 */
const SLOW_TPS = 3;

function howText(v) {
  if (v.reason !== 'completed') return v.reason;
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
