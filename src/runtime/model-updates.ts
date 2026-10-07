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

  let failed: string | undefined;
  for (const family of families) {
    const found: string[] = [];
    for (const candidate of nextFamilies(family)) {
      try {
        const res = await fetchImpl(`${OLLAMA_REGISTRY}/${candidate}/tags/list`, { signal: opts.signal });
        if (res.ok) found.push(candidate);
        // 404 だけが「その名前は無い」。401・403・429・5xx は、訊けなかった
        else if (res.status !== 404) { failed ??= `${res.status}`; break; }
      } catch (e) {
        // 繋がらないのは、新しいものが無いこととは違う。ここで止める
        failed ??= e instanceof Error ? e.message : String(e);
        break;
      }
    }
    if (found.length > 0) findings.push({ current: family, found });
  }
  return orUnreachable(findings, failed);
}

/**
 * 分かった分を返す。一件も分からず、訊けなかった問い合わせがあったなら投げる。
 * 空を返すと「新しい世代は見つかりませんでした」になり、繋がらなかったのか無かったのかを取り違えさせていた（社用PCで外へ出られないときなど）
 */
function orUnreachable(findings: NewerFinding[], failed: string | undefined): NewerFinding[] {
  if (findings.length === 0 && failed !== undefined) throw new Error(`配布元に訊けませんでした（${failed}）`);
  return findings;
}

/**
 * 配布元の名前として、受け取ってよい形か。
 *
 * ここは**外から来た文字列がそのまま手元へ入る**数少ない場所。
 * Hugging Face の置き場名は誰でも作れるので、名前そのものに
 * 何を書かれていてもおかしくない。持ち帰った名前は利用者に見せ、
 * 整備担当（QUARTERMASTER）の目にも入る。
 *
 * ここでは**中身を疑うより、形を強制する**。
 * 置き場名の形は決まっている（`namespace/name`、英数字と `.` `-` `_` だけ）ので、
 * その形から外れたものは、名前ではない何かとして捨てられる。
 * 当てはめで怪しい文言を探すより、こちらの方が漏れが無い。
 */
export function looksLikeRepoId(id: string): boolean {
  if (id.length === 0 || id.length > 120) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
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
    // 名前の形をしていないものは、名前ではない。持ち帰らない。
    .filter((m) => looksLikeRepoId(m.id))
    .map((m) => ({ id: m.id, lastModified: m.lastModified, downloads: m.downloads }));
}

/**
 * GGUF の名前から、家族の名前を取り出す。
 *
 * `qwen2.5-3b-instruct-q4_k_m.gguf` → `qwen2.5`。量子化や大きさは家族ではない。
 * 形が読めなければ undefined（知らない名前を当てずっぽうで問い合わせない）。
 */
export function ggufFamily(file: string): string | undefined {
  const base = file.toLowerCase().replace(/\.gguf$/, '');
  const m = /^([a-z]+[a-z-]*?)(\d+(?:\.\d+)?)(?=[-_.]|$)/.exec(base);
  return m ? `${m[1]}${m[2]}` : undefined;
}

/**
 * GGUF を置いている人に、次の世代を訊く。
 *
 * これまで Ollama の配布元に GGUF の**ファイル名**で訊いていた
 * （`qwen2.5-3b-instruct-q4_k_m.gguf` という札は無いので、何も出ない）。
 * こちらは Hugging Face に、次の世代の名前で GGUF を探す。
 */
export async function findNewerGguf(opts: {
  installed: string[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<NewerFinding[]> {
  const findings: NewerFinding[] = [];
  const families = new Map<string, string>(); // 家族 → いま使っている名前（代表）
  for (const file of opts.installed) {
    const fam = ggufFamily(file);
    if (fam && !families.has(fam)) families.set(fam, file);
  }
  let failed: string | undefined;
  for (const [family, current] of families) {
    const found: string[] = [];
    for (const next of nextFamilies(family)) {
      let hits: HfModel[];
      try {
        hits = await findRecentGguf({ query: next, limit: 5, fetchImpl: opts.fetchImpl, signal: opts.signal });
      } catch (e) {
        // 繋がらない・断られたのは、無いこととは違う（前は空として数え、「見つかりませんでした」と言っていた）
        failed ??= e instanceof Error ? e.message : String(e);
        break;
      }
      // 名前に次の世代が入っているものだけ。検索は緩いので、こちらで締める。
      const real = hits.filter((h) => h.id.toLowerCase().includes(next.toLowerCase()));
      if (real.length > 0) found.push(real[0]!.id);
    }
    if (found.length > 0) findings.push({ current, found });
  }
  return orUnreachable(findings, failed);
}

/**
 * 人に見せる形。`hint` は打つ一手の書き方（配った形には npm が無い。CLI は `how` を渡す）。
 */
export function describeNewer(
  findings: NewerFinding[],
  hint: (task: string, args?: string) => string = (task, args) => `npm run ${task}${args ? ` -- ${args}` : ''}`,
): string {
  if (findings.length === 0) return '新しい世代は見つかりませんでした。';
  const lines = ['新しい世代が出ています', ''];
  for (const f of findings) {
    lines.push(`  ${f.current} → ${f.found.join(', ')}`);
  }
  lines.push('');
  lines.push(`  取ってくる: ${hint('models', '--get <名前>')}`);
  lines.push('  ※ 新しい＝この機械で動く、ではありません。');
  lines.push(`    大きさと活性パラメータを見てから選んでください（${hint('models')}）。`);
  return lines.join('\n');
}

/**
 * 使っている道に合わせて、次の世代を訊く。
 *
 * **ここは `ollama:` で始まる候補だけを見ていた。**中で読む道（inproc）や
 * llama.cpp を使っていると候補は `inproc:Foo.gguf` の形なので、一件も
 * 当たらない。つまり**新しい世代を見に行く仕組みが、この構成では一度も
 * 動いていなかった**。作ってはあるのに、繋がっていなかった。
 *
 * 名前の頭で判じない。**どの道を使っているかは、設定が知っている。**
 *
 * 入っているものが無いときは、カタログの家族から訊く。入れた直後は
 * 何も入っていないので、そこで黙ると**最初の一つが古いまま固定される**。
 * カタログは手で書いた表なので、必ず古くなる（そう書いてある）。
 * 古くなったことに気づく道を、表の外に置く。
 */
export async function findNewerFor(opts: {
  runtimeKind: string;
  installed: string[];
  /** 何も入っていないときに訊く家族。ふつうはカタログから渡す。 */
  seed?: string[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<NewerFinding[]> {
  const gguf = opts.runtimeKind === 'inproc' || opts.runtimeKind === 'llamacpp';
  // `provider:model` で渡ってきたら、model の側だけ見る（model にも : が入る）。
  const bare = opts.installed.map((r) => {
    const at = r.indexOf(':');
    return at < 0 ? r : r.slice(at + 1);
  }).filter((r) => r.length > 0);
  const installed = bare.length > 0 ? bare : (opts.seed ?? []);
  if (installed.length === 0) return [];
  const ask = gguf ? findNewerGguf : findNewerOllama;
  return ask({ installed, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
}
