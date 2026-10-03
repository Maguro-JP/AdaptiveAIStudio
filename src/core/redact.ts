/**
 * トークンの値を出さない。報告・記憶・提案のように、残る・外へ出るものの入口で、機械的に伏せる。
 *
 * 見るのは二つ。項目の名前（`apiKey` `Authorization` など）と、**値そのものの形**。
 * 設定は名前しか書かない作りだが、記録（`ui.log`）や点検の出力には、項目名の無い
 * まま値が出ることがある（見出しを丸ごと出した行、外のツールのエラーなど）。
 * 名前だけで判じていると、そこがすり抜ける。
 */
export function redactSecrets(text: string): string {
  return text
    // 項目の名前で判じる。
    .replace(/("([^"\\]*(key|token|secret|password|passwd|credential|authorization|cookie)[^"\\]*)"\s*:\s*)"[^"]*"/gi, '$1"（伏せました）"')
    // 値の形で判じる。`Bearer ` の後ろ、と、よく知られた頭の付いたもの。
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer （伏せました）')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '（伏せました）')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, '（伏せました）')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '（伏せました）')
    // 検問所（`harness/gate.ts`）が秘密として知っている形のうち、ここに無かったもの。GitHub の fine-grained トークン、AWS の鍵、Hugging Face のトークン
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '（伏せました）')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '（伏せました）')
    .replace(/\bhf_[A-Za-z0-9]{20,}\b/g, '（伏せました）')
    // `.env` の形（`GITHUB_TOKEN=...`）と、命令の引数の形（`--token xxx`・`"--token", "xxx"`）。名前が JSON の項目でないと上で当たらない
    // 値は引用符で囲まれていてもよい（`.env` の `KEY="..."`、`--token="..."`）。囲みごと伏せる
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*=\s*)(?!（伏せました）)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, '$1（伏せました）')
    // 引数の名前は単語の頭から（`max-token`・`non-secret` のような普通の言葉の一部には当てない）
    .replace(/(?<![\w-])(--?(?:api[-_]?key|token|secret|password)\b)(\s*=\s*|["']?\s*,\s*|\s+)(?!（伏せました）)(?:"[^"\n]*"|'[^'\n]*'|[^\s"',\]]+)/gi, '$1$2（伏せました）');
}
