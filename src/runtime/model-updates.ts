/**
 * 新しいモデルが出ていないかを見に行く。
 *
 * ローカルで動かす以上、**古くて性能の低いモデルを使い続ける理由が無い**。
 * トークン単価が無いので、良いものが出たら乗り換えた方が常に得になる。
 *
 * ところが、これまでの作りでは乗り換えの起点が
 * 「カタログを書いた人が名前を書き換える」しかなかった。
 * それでは書いた人が古くなった時点で止まる（実際に二度止まった）。
 * だから**配布元に訊く**形にする。
 *
 * 名前の付け方には規則性がある。
 *   qwen3 → qwen3.5 → qwen3.6 → qwen3.8 …
 * 完全ではないが、「次の世代があるか」を試すには足りる。
 * 当てずっぽうに見えるが、**外れても 404 が返るだけ**で害が無い。
 */

export interface Family {
  /** 世代を含む名前（qwen3.5） */
  family: string;
  /** 大きさなどの札（9b） */
  tag?: string;
}

/** `qwen3.5:9b` を家族と札に分ける。 */
export function splitRef(ref: string): Family {
  const at = ref.indexOf(':');
  return at < 0 ? { family: ref } : { family: ref.slice(0, at), tag: ref.slice(at + 1) };
}

/**
 * 次にあり得る世代の名前を並べる。
 *
 * `qwen3.5` なら 3.6〜3.9 と 4。`qwen3` なら 3.1〜3.9 と 4。
 * 上限を置くのは、無限に問い合わせないため。
 */
export function nextFamilies(family: string, max = 8): string[] {
  const m = /^([a-z][a-z0-9-]*?)(\d+)(?:\.(\d+))?$/i.exec(family);
  if (!m) return [];
  const [, stem, majorText, minorText] = m;
  const major = Number(majorText);
  const minor = minorText === undefined ? undefined : Number(minorText);

  // 次の整数（qwen4）は必ず見る。小数で枠を使い切ると、
  // 世代が飛んだときに気づけなくなるため、1枠を空けておく。
  const out: string[] = [];
  const room = Math.max(1, max - 1);
  for (let i = (minor ?? 0) + 1; i <= 9 && out.length < room; i += 1) {
    out.push(`${stem}${major}.${i}`);
  }
  out.push(`${stem}${major + 1}`);
  return out;
}

export interface NewerFinding {
  /** いま使っているもの */
  current: string;
  /** 見つかった新しい家族 */
  found: string[];
}

const OLLAMA_REGISTRY = 'https://registry.ollama.ai/v2/library';

/**
 * Ollama の配布元に、次の世代があるかを訊く。
 *
 * 公式の一覧を丸ごと取る口は無いので、名前を当てて存在を確かめる。
 * 在れば 200、無ければ 404。**無いことは失敗ではない**ので、静かに捨てる。
 */
export async function findNewerOllama(opts: {
  installed: string[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<NewerFinding[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const families = [...new Set(opts.installed.map((r) => splitRef(r).family))];
  const findings: NewerFinding[] = [];

  for (const family of families) {
    const found: string[] = [];
    for (const candidate of nextFamilies(family)) {
      try {
        const res = await fetchImpl(`${OLLAMA_REGISTRY}/${candidate}/tags/list`, { signal: opts.signal });
        if (res.ok) found.push(candidate);
      } catch {
        // 繋がらないのは、新しいものが無いこととは違う。
        // ここで止めて、分かった分だけ返す。
        break;
      }
    }
    if (found.length > 0) findings.push({ current: family, found });
  }
  return findings;
}

export interface HfModel {
  id: string;
  lastModified?: string;
  downloads?: number;
}

/**
 * Hugging Face に、最近更新された GGUF を訊く。
 *
 * こちらは一覧の口があるので、名前を当てる必要が無い。
 * 「よく落とされている順」で見る。新しいだけで誰も使っていないものを
 * 勧めても仕方がないため。
 */
export async function findRecentGguf(opts: {
  query: string;
  limit?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<HfModel[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = new URL('https://huggingface.co/api/models');
  url.searchParams.set('search', opts.query);
  url.searchParams.set('filter', 'gguf');
  url.searchParams.set('sort', 'downloads');
  url.searchParams.set('direction', '-1');
  url.searchParams.set('limit', String(opts.limit ?? 10));

  const res = await fetchImpl(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`一覧を調べられませんでした (${res.status})`);
  const json = await res.json() as Array<{ id?: string; lastModified?: string; downloads?: number }>;
  return (Array.isArray(json) ? json : [])
    .filter((m): m is HfModel => typeof m.id === 'string')
    .map((m) => ({ id: m.id, lastModified: m.lastModified, downloads: m.downloads }));
}

/** 人に見せる形。 */
export function describeNewer(findings: NewerFinding[]): string {
  if (findings.length === 0) return '新しい世代は見つかりませんでした。';
  const lines = ['新しい世代が出ています', ''];
  for (const f of findings) {
    lines.push(`  ${f.current} → ${f.found.join(', ')}`);
  }
  lines.push('');
  lines.push('  取ってくる: npm run models -- --get <名前>');
  lines.push('  ※ 新しい＝この機械で動く、ではありません。');
  lines.push('    大きさと活性パラメータを見てから選んでください（npm run models）。');
  return lines.join('\n');
}
