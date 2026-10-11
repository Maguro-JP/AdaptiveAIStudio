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
    // 値は、逃がした引用符（`\"`）を含む文字と、数も伏せる（`"password":"ab\"cd"` の後ろ半分・`"pin": 1234` を出していた）
    .replace(/("([^"\\]*(key|token|secret|password|passwd|credential|authorization|cookie)[^"\\]*)"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|-?\d[\d.]*)/gi, '$1"（伏せました）"')
    // 文字列の中に入った JSON（ツールの引数は JSON を文字列にした形で来る: `"{\"password\":\"…\"}"`）。項目名が逃がした引用符で囲まれるので、上では当たらなかった
    .replace(/(\\"([^"\\]*(key|token|secret|password|passwd|credential|authorization|cookie)[^"\\]*)\\"\s*:\s*)(?:\\"(?:[^"\\]|\\(?!")[^"])*\\"|-?\d[\d.]*)/gi, '$1\\"（伏せました）\\"')
    // 道の中のログイン（`https://user:pass@host`）。監査の記録だけが伏せていた
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1（伏せました）@')
    // 秘密鍵のかたまり（中身ごと）、JWT、Google の鍵、AWS の一時的な鍵
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '（伏せました）')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '（伏せました）')
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '（伏せました）')
    .replace(/\bASIA[0-9A-Z]{16}\b/g, '（伏せました）')
    // 値の形で判じる。`Bearer ` の後ろ、と、よく知られた頭の付いたもの。
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer （伏せました）')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '（伏せました）')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, '（伏せました）')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '（伏せました）')
    // 検問所（`harness/gate.ts`）が秘密として知っている形のうち、ここに無かったもの。GitHub の fine-grained トークン、AWS の鍵、Hugging Face のトークン
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '（伏せました）')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '（伏せました）')
    .replace(/\bhf_[A-Za-z0-9]{20,}\b/g, '（伏せました）')
    // Stripe・GitLab・npm の鍵
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g, '（伏せました）')
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}/g, '（伏せました）')
    .replace(/\bnpm_[A-Za-z0-9]{36}\b/g, '（伏せました）')
    // `.env` の形（`GITHUB_TOKEN=...`）と、命令の引数の形（`--token xxx`・`"--token", "xxx"`）。名前が JSON の項目でないと上で当たらない
    // 値は引用符で囲まれていてもよい（`.env` の `KEY="..."`、`--token="..."`）。囲みごと伏せる
    // 名前の大小は問わない（`~/.aws/credentials` の `aws_secret_access_key = …`）。YAML や見出しの `password: …` も
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*=\s*)(?!（伏せました）)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, '$1（伏せました）')
    // 小文字の名前と `:` の形は、値が鍵らしい（12 文字以上で、`.`・括弧・空白を含まない）ときだけ。道の問い合わせ（`?api_key=…&v=1`）の `&` の手前でも切る。コードの `apiKey: string`・`token = req.headers.x` は伏せない
    .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[=:]\s*)(?!（伏せました）)(["']?)[A-Za-z0-9+/_=-]{12,}\2(?=[\s,}&#]|$)/gim, '$1（伏せました）')
    // パスワードは短くても伏せる（`password: hunter2` は上の 12 文字の条件で出ていた）。型の名前（`password: string`）と、コードの式（`.`・括弧を含む値）は伏せない
    .replace(/\b((?:password|passwd|pwd)\s*[=:]\s*)(?!（伏せました）)(?!(?:string|number|boolean|undefined|null)\b)(["']?)[^\s.()"']{4,}?\2(?=[\s,}&]|$)/gim, '$1（伏せました）')
    // 日本語の名前（`パスワードは S3cr3t!x`・`暗証番号：1234`）
    .replace(/((?:パスワード|暗証番号|合い言葉|トークン|秘密鍵)\s*(?:は|[:：=＝])\s*)(?!（伏せました）)[!-~]{4,}/g, '$1（伏せました）')
    .replace(/\b(Authorization\s*:\s*(?:Basic|Token)\s+)[A-Za-z0-9+/=._-]{8,}/gi, '$1（伏せました）')
    // 引数の名前は単語の頭から（`max-token`・`non-secret` のような普通の言葉の一部には当てない）
    .replace(/(?<![\w-])(--?(?:api[-_]?key|token|secret|password)\b)(\s*=\s*|["']?\s*,\s*|\s+)(?!（伏せました）)(?:"[^"\n]*"|'[^'\n]*'|[^\s"',\]]+)/gi, '$1$2（伏せました）');
}
