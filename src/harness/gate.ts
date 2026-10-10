/**
 * 検問所 — 出入りする物を検める。
 *
 * 外への出口をひとつに絞る作りはやめた。数を絞っても中身は見ていないので、
 * 遅くなるだけで安全にはならない。**守るのは扉の数ではなく、通る物**。
 *
 * ここで見るのは二方向。
 *
 *   持ち込み（inbound）  外から入ってくるもの。こちらを操ろうとする指示が混ざり得る
 *   持ち出し（outbound） 外へ出ていくもの。出してはいけないものが混ざり得る
 *
 * **判定は機械が行う。** 「怪しいものは報告してください」とモデルに頼む形にすると、
 * 頼まれた側が見落とした時点で素通りする。頼みではなく、関所として置く。
 *
 * 完全ではない。当てはめで見つかるものしか見つからないので、
 * **すり抜けることを前提に**、止めた記録と通した記録の両方を残す。
 */

export type Severity = 'block' | 'warn';

export interface Finding {
  severity: Severity;
  /** 何に当たったか */
  kind: string;
  /** 人が読む説明 */
  detail: string;
  /** 当たった箇所（前後を少しだけ。全部は出さない） */
  excerpt?: string;
}

export interface Verdict {
  /** 通してよいか */
  passed: boolean;
  findings: Finding[];
}

interface Pattern {
  kind: string;
  match: RegExp;
  severity: Severity;
  detail: string;
}

/**
 * 持ち込んではいけないもの。
 *
 * いちばん危ないのは「こちらの指示を上書きしようとする文」。
 * 外の頁に仕込んでおけば、読んだ側がそのまま従う可能性がある。
 */
const INBOUND: Pattern[] = [
  {
    kind: '指示の上書き',
    match: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?|前の指示は?(すべて)?無視|これまでの指示を忘れ/i,
    severity: 'block',
    detail: 'こちらの指示を上書きしようとする文が含まれています。',
  },
  {
    kind: '役割の乗っ取り',
    match: /you\s+are\s+now\s+|new\s+system\s+prompt|システムプロンプト(を|は)(無視|変更)|あなたは今から/i,
    severity: 'block',
    detail: '役割を書き換えようとする文が含まれています。',
  },
  {
    kind: '秘密の要求',
    match: /(reveal|print|show|output)\s+(your\s+)?(system\s+prompt|instructions|api[_\s-]?key)|環境変数を(出力|表示)/i,
    severity: 'block',
    detail: '内部の情報を出させようとする文が含まれています。',
  },
  {
    kind: '道具の呼び出し',
    match: /<tool[_▁]call>|"(function|tool)_call"\s*:/i,
    severity: 'warn',
    detail: '道具の呼び出しに見える記述が含まれています。外から来たものを呼び出しとして扱いません。',
  },
  {
    kind: '見えない文字',
    // 幅ゼロの文字やタグ文字は、人には見えないまま指示を運べる。
    match: /[​-‏⁠-⁤﻿\u{e0000}-\u{e007f}]/u,
    severity: 'warn',
    detail: '人の目に見えない文字が含まれています。',
  },
];

/**
 * 持ち出してはいけないもの。
 *
 * 外へ出す前に見る。一度出たものは戻せないので、こちらは特に厳しく。
 */
const OUTBOUND: Pattern[] = [
  {
    kind: '秘密鍵',
    // 暗号化した鍵（`ENCRYPTED PRIVATE KEY`）も止める。トークンで守られていても、外へ出せば破られうる
    // PGP は `PRIVATE KEY BLOCK-----` で終わる（`KEY-----` だけを見ていたので、一度も当たらなかった）
    match: /-----BEGIN\s+(?:[A-Z0-9]+\s+)*PRIVATE KEY(?: BLOCK)?-----/,
    severity: 'block',
    detail: '秘密鍵が含まれています。',
  },
  {
    kind: '合言葉',
    // 見た目で分かる形のものだけを当てる。当てずっぽうで弾くと使えなくなる。
    // 今の Anthropic と OpenAI の鍵は `sk-ant-api03-…` `sk-proj-…` のように途中に `-` が入る。`sk-` の直後に英数字だけを
    // 求めていたので、当たらずに外へ出ていた。`-` を受けるのは決まった頭の字（prefix）の後だけ（`sk-learn-pipeline-tutorial` のような語を止めない）。
    // 末尾も `\b` ではなく、鍵の字が続かないことで見る（`-` で終わる鍵がある）。
    // 伏せる側（redact.ts）が知っている Google（`AIza`）・Hugging Face（`hf_`）・一時の AWS（`ASIA`）も当てる
    match: /\b(sk-(?:ant-[a-z0-9]+-|proj-|svcacct-|admin-)[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|hf_[A-Za-z0-9]{20,})(?![A-Za-z0-9_-])/,
    severity: 'block',
    detail: '合言葉（APIキー・トークン）と思われる文字列が含まれています。',
  },
  {
    kind: '設定ファイルの中身',
    /*
     * 大小を問わず、頭の `export ` と引用符・`:` も受ける。`~/.aws/credentials` は小文字（`aws_secret_access_key = …`）、
     * 殻の設定は `export AWS_SECRET_ACCESS_KEY=…`、JSON は `"AWS_SECRET_ACCESS_KEY": "…"` で書くので、どれも素通りしていた。
     * 広げた分は、値が行末までの長い文字そのもののときだけにする（`github_token = os.environ[...]` や
     * `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` のような、値を持たないコードと CI の設定は止めない）。大文字の `NAME=` は前のとおり値を問わない
     */
    // Windows の殻の書き方（`set NAME=…`・`setx NAME …`・`$env:NAME="…"`）も、頭に付く字として受ける
    match: /^\s*(?:(?:export\s+|set\s+|\$env:)?(AWS_SECRET_ACCESS_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN)\s*=|setx\s+(AWS_SECRET_ACCESS_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN)\s+\S|(?:export\s+|set\s+|\$env:)?["']?(?:aws_secret_access_key|anthropic_api_key|openai_api_key|github_token|gh_token|AWS_SECRET_ACCESS_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN)["']?\s*[=:]\s*["']?[A-Za-z0-9/+=_-]{16,}["']?,?\s*$)/m,
    severity: 'block',
    detail: '合言葉を含む設定が含まれています。',
  },
  {
    kind: '手元の場所',
    // 大小を問わない。Windows の道は大小を区別しないので、`c:\users\…` と
    // 書かれただけで素通りしていた。ドライブも C: だけではない
    // （データを C: 以外のドライブに置く人もいる）。
    match: /(?:\/home\/[^/\s]+\/|\/Users\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/i,
    severity: 'warn',
    detail: '手元の絶対パスが含まれています（利用者名が漏れます）。',
  },
];

/** 前後を少しだけ切り出す。全部を記録に残すと、そこから漏れる。 */
function excerpt(text: string, at: number, len: number): string {
  const from = Math.max(0, at - 20);
  const raw = text.slice(from, Math.min(text.length, at + len + 20));
  // 合言葉そのものは記録に残さない。伏せる。
  return raw.replace(/[A-Za-z0-9_-]{20,}/g, (m) => `${m.slice(0, 4)}…（伏せました）`);
}

function inspect(text: string, patterns: Pattern[]): Verdict {
  const findings: Finding[] = [];
  for (const p of patterns) {
    const m = p.match.exec(text);
    if (!m) continue;
    findings.push({
      severity: p.severity,
      kind: p.kind,
      detail: p.detail,
      excerpt: excerpt(text, m.index, m[0].length),
    });
  }
  return { passed: !findings.some((f) => f.severity === 'block'), findings };
}

/** 外から入ってくるものを検める。 */
export function inspectInbound(text: string): Verdict {
  return inspect(text, INBOUND);
}

/** 外へ出ていくものを検める。 */
export function inspectOutbound(text: string): Verdict {
  return inspect(text, OUTBOUND);
}

/**
 * 止めたときに、モデルへ返す文。
 *
 * 「駄目でした」だけでは、モデルは同じことを繰り返す。
 * 何に当たったのかと、次にどうすればよいのかまで返す。
 */
export function describeVerdict(verdict: Verdict, direction: 'inbound' | 'outbound'): string {
  const where = direction === 'inbound' ? '外から入ってきたもの' : '外へ出そうとしたもの';
  const blocked = verdict.findings.filter((f) => f.severity === 'block');
  const warned = verdict.findings.filter((f) => f.severity === 'warn');

  const lines: string[] = [];
  if (blocked.length > 0) {
    lines.push(`検問で止めました（${where}）。`);
    for (const f of blocked) lines.push(`  ・${f.kind}: ${f.detail}`);
    lines.push(
      direction === 'inbound'
        ? '  この内容は渡しません。別の出典を当たるか、手元で分かる範囲で進めてください。'
        : '  この内容は送りません。含めるものを見直してください。',
    );
  }
  if (warned.length > 0) {
    lines.push(`${blocked.length > 0 ? 'あわせて' : '検問の記録'}（${where}）:`);
    for (const f of warned) lines.push(`  ・${f.kind}: ${f.detail}`);
  }
  return lines.join('\n');
}
