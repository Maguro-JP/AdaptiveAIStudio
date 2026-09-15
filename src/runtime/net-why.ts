/**
 * 網の失敗を、人の言葉で言う。**一か所に集める。**
 *
 * ここは model-install.ts の中にあった。**使われていたのは同じファイルの
 * 一か所だけ**で、モデルの一覧・llama-server・Ollama・新しい版の確認は、
 * どれも生の文をそのまま出していた。会社の回線で最初に見えるのは
 * `fetch failed` の一語で、何が起きたのかも次の一手も分からない。
 *
 * 外へ出て失敗したことを人に見せる所は、全部ここを通す。
 */
export function describeNet(e: unknown): string {
  const chain: string[] = [];
  for (let at: unknown = e, depth = 0; at instanceof Error && depth < 5; depth += 1) {
    chain.push(at.message);
    const code = (at as { code?: unknown }).code;
    if (typeof code === 'string') chain.push(code);
    at = (at as { cause?: unknown }).cause;
  }
  const m = chain.join(' / ') || String(e);
  if (/terminated|aborted|ECONNRESET|socket hang up/i.test(m)) return '途中で切れました';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return '配布元の名前を引けません（回線が繋がっていないようです）';
  if (/ETIMEDOUT|timeout/i.test(m)) return '時間切れです';
  if (/certificate|CERT_|self.signed/i.test(m)) return '証明書で断られました（会社の回線で起きます）';
  if (/ECONNREFUSED/i.test(m)) return '繋ぐ先に断られました';
  if (/EPROTO|SSL|TLS/i.test(m)) return '暗号化のやりとりで断られました（会社の回線で起きます）';
  /*
   * **最後に `fetch failed` を拾う。**
   *
   * この関数の説明にも「会社の回線で最初に見えるのは `fetch failed` の一語」と
   * 書いてありながら、言い換えていなかった。中の理由（ECONNREFUSED など）が
   * cause に付いていれば上で拾えるが、付かずにこの一語だけで来ることがある。
   * 上のどれにも当たらなかったときの受け皿なので、いちばん後ろに置く。
   */
  if (/fetch failed/i.test(m)) return '繋げませんでした（回線か、串（プロキシ）の設定かもしれません）';
  return m;
}
