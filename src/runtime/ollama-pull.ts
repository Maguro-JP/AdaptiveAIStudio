/**
 * Ollama にモデルを取ってこさせる。
 *
 * llama.cpp の道では GGUF を自分で取ってこられるようになったのに、
 * Ollama の道は「`ollama pull` を人が打つ」ままだった。
 * **同じ非対称を残さない**。どちらの道でも `npm run models -- --get` で済ませる。
 *
 * 取ってくるのは Ollama 自身で、こちらは頼んで進み具合を見るだけ。
 * 置き場も、二重取得を避ける仕組みも、あちらが持っている。
 */

export interface PullOptions {
  /** OpenAI 互換の口（.../v1）。native の口はここから導く。 */
  baseUrl: string;
  /** 取ってくるモデル名（例: qwen2.5-coder:7b） */
  ref: string;
  onProgress?: (line: string) => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** native API の場所。/v1 が付いていれば落とす。 */
export function nativeBase(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
}

/**
 * 取ってくる。
 *
 * Ollama は進み具合を NDJSON（1行1件）で流してくる。
 * 数GBを待たせるので、黙らずに割合を出す。
 */
export async function pullModel(opts: PullOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onProgress ?? (() => {});
  const url = `${nativeBase(opts.baseUrl)}/api/pull`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: opts.ref, stream: true }),
      signal: opts.signal,
    });
  } catch (e) {
    // 繋がらないのが一番多い。原因を言い当てておく。
    throw new Error(
      `Ollama に繋がりません（${url}）。\n`
      + '`ollama serve` が動いているか確認してください。'
      + `\n（元の理由: ${e instanceof Error ? e.message : String(e)}）`,
    );
  }

  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? `Ollama がそのモデルを知りません: ${opts.ref}\nhttps://ollama.com/library で名前を確かめてください。`
        : `取ってこられませんでした (${res.status})`,
    );
  }

  let lastShown = -1;
  let sawSuccess = false;

  for await (const line of ndjson(res, opts.signal)) {
    // 進み具合。status は「pulling manifest」「downloading ...」など。
    const status = typeof line.status === 'string' ? line.status : '';
    const total = typeof line.total === 'number' ? line.total : 0;
    const done = typeof line.completed === 'number' ? line.completed : 0;

    // 取得の途中でも失敗を流してくることがある。黙って成功にしない。
    if (typeof line.error === 'string' && line.error.length > 0) {
      throw new Error(`Ollama が断りました: ${line.error}`);
    }

    if (total > 0) {
      const pct = Math.floor((done / total) * 100);
      if (pct >= lastShown + 10) {
        lastShown = pct;
        log(`  ${pct}%（${(done / 1024 ** 3).toFixed(1)}GB / ${(total / 1024 ** 3).toFixed(1)}GB）`);
      }
    } else if (status && status !== 'success') {
      log(`  ${status}`);
    }

    if (status === 'success') sawSuccess = true;
  }

  // 最後まで流れても success が来ていなければ、取れていない。
  if (!sawSuccess) {
    throw new Error('取得が最後まで終わりませんでした。もう一度実行してください。');
  }
}

/** 1行1件の JSON を読む。 */
async function* ndjson(res: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const body = res.body;
  if (!body) throw new Error('Ollama が何も返しませんでした');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    if (signal?.aborted) throw new Error('中断されました');
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) yield parse(line);
    }
  }
  const rest = buffer.trim();
  if (rest) yield parse(rest);
}

function parse(line: string): Record<string, unknown> {
  try {
    const v = JSON.parse(line) as unknown;
    return typeof v === 'object' && v !== null ? v as Record<string, unknown> : {};
  } catch {
    // 壊れた行は捨てる。1行読めないだけで全体を落とさない。
    return {};
  }
}
