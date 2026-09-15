/**
 * 条件が満たされるまで待つ。
 *
 * **決め打ちの待ちを、検査に書かない。**「200ms 待ってから見る」は、
 * 機械が空いていれば通り、混んでいれば落ちる。走らせる場所で結果が
 * 変わる検査になる。実際に、試験を全部まとめて走らせたときだけ落ちる
 * ものを二つ作った。
 *
 * 逆に、待ちが**短すぎて壊れていても通る**方の間違いもある
 * （まだ起きていないだけなのを「起きない」と読む）。どちらも、
 * 「起きるまで見る／上限で諦める」に直せば無くなる。
 *
 * 上限まで待っても満たされなければ、その場で落とす。**黙って先へ進めない。**
 */
export async function until(
  ok: () => boolean | Promise<boolean>,
  what: string,
  { timeoutMs = 30_000, everyMs = 20 }: { timeoutMs?: number; everyMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ok()) return;
    if (Date.now() >= deadline) throw new Error(`${timeoutMs}ms 待っても、こうならなかった: ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
