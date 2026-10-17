/**
 * 冗長実行 — ローカルだけができる戦い方。
 *
 * クラウドではトークンごとに課金されるので、同じ作業を複数回走らせるのは損。
 * ローカルは計算が無料なので、**遊んでいる計算資源は捨てているのと同じ**。
 *
 * したがってローカルは、クラウドが採算上できないことをやって戦う。
 *
 *   race    : 同じ作業を複数モデルに同時にやらせ、最初に通ったものを採る
 *   bestOf  : 複数の答えを作り、検証して最も良いものを採る
 *
 * どちらも「計算を品質と速度に変換する」手法。
 * 品質で大手に劣るローカルモデルが、量で埋め合わせるための唯一の道。
 */

export interface Attempt<R> {
  label: string;
  run(signal: AbortSignal): Promise<R>;
}

export type RaceEvent =
  | { type: 'launch'; label: string; total: number }
  | { type: 'settle'; label: string; accepted: boolean; ms: number; error?: string }
  | { type: 'cancel'; label: string; reason: string }
  | { type: 'winner'; label: string; ms: number };

export interface RaceOutcome<R> {
  winner?: { label: string; result: R; ms: number };
  /** 採用されなかった結果も残す。比較・実測の材料になる。 */
  others: Array<{ label: string; result?: R; error?: string; ms: number; accepted: boolean }>;
}

/**
 * 最初に「合格」した結果を採用し、残りを打ち切る。
 *
 * 速いモデルが当たれば速く終わり、外しても遅い確実なモデルが拾う。
 * 単独実行より遅くなることはない（最速の成功に律速される）。
 */
export async function race<R>(
  attempts: Attempt<R>[],
  accept: (r: R) => boolean,
  signal: AbortSignal,
  onEvent?: (e: RaceEvent) => void,
): Promise<RaceOutcome<R>> {
  if (attempts.length === 0) return { others: [] };
  // 始める前に止められていた（口が空くのを待っている間に止めた）。止めたのに全部を最後まで走らせない
  if (signal.aborted) return { others: [] };

  const controllers = attempts.map(() => new AbortController());
  const abortAll = (reason: string, except?: number) => {
    controllers.forEach((c, i) => {
      if (i !== except && !done.has(i) && !c.signal.aborted) {
        c.abort();
        onEvent?.({ type: 'cancel', label: attempts[i]!.label, reason });
      }
    });
  };
  const onOuterAbort = () => abortAll('全体が中断された');
  signal.addEventListener('abort', onOuterAbort, { once: true });

  const started = Date.now();
  // どの試みの結果かを番号で持つ（名前で外すと、同じ名前の試み＝同じモデルを二本走らせたとき、負けた方まで消えた）
  const settled: Array<RaceOutcome<R>['others'][number] & { index: number }> = [];
  let winner: RaceOutcome<R>['winner'];
  // 勝った試みの番号と、もう終わった試み。取り消しの知らせは、まだ走っているものにだけ出す（前は終わった順の番号を除いていたので、
  // 負けた試みと同じ一巡で終わった勝ちの試みにも「取り消し」と出し、画面と記録が食い違った）
  let winnerIndex: number | undefined;
  const done = new Set<number>();

  const running = new Map<number, Promise<number>>();
  attempts.forEach((a, i) => {
    onEvent?.({ type: 'launch', label: a.label, total: attempts.length });
    const at = Date.now();
    const p = a.run(controllers[i]!.signal).then(
      (result) => {
        const ms = Date.now() - at;
        const ok = accept(result);
        settled.push({ index: i, label: a.label, result, ms, accepted: ok });
        onEvent?.({ type: 'settle', label: a.label, accepted: ok, ms });
        done.add(i);
        if (ok && !winner) { winner = { label: a.label, result, ms }; winnerIndex = i; }
        return i;
      },
      (e: unknown) => {
        const ms = Date.now() - at;
        const error = e instanceof Error ? e.message : String(e);
        settled.push({ index: i, label: a.label, error, ms, accepted: false });
        onEvent?.({ type: 'settle', label: a.label, accepted: false, ms, error });
        done.add(i);
        return i;
      },
    ).finally(() => { running.delete(i); });
    running.set(i, p);
  });

  try {
    while (running.size > 0) {
      const finishedIndex = await Promise.race(running.values());
      if (winner) {
        abortAll('先に成功した結果を採用', winnerIndex ?? finishedIndex);
        break;
      }
    }
    // 打ち切った側の後始末を待つ（プロセスやファイルを掴んだままにしない）
    await Promise.allSettled(running.values());
  } finally {
    signal.removeEventListener('abort', onOuterAbort);
  }

  if (winner) onEvent?.({ type: 'winner', label: winner.label, ms: Date.now() - started });

  return {
    winner,
    others: settled.filter((s) => s.index !== winnerIndex).map(({ index: _index, ...rest }) => rest),
  };
}

export interface BestOfOutcome<R> {
  best?: { label: string; result: R; score: number };
  ranked: Array<{ label: string; score: number; error?: string }>;
}

/**
 * 全て走らせ、採点して最良を採る。
 *
 * race と違い最後まで待つので遅い。そのぶん品質は上がる。
 * 「テストが通るか」のような客観的な採点ができる場面で使う。
 */
export async function bestOf<R>(
  attempts: Attempt<R>[],
  score: (r: R) => Promise<number> | number,
  signal: AbortSignal,
  onEvent?: (e: RaceEvent) => void,
): Promise<BestOfOutcome<R>> {
  const results = await Promise.all(attempts.map(async (a) => {
    const at = Date.now();
    onEvent?.({ type: 'launch', label: a.label, total: attempts.length });
    try {
      const result = await a.run(signal);
      const s = await score(result);
      onEvent?.({ type: 'settle', label: a.label, accepted: s > 0, ms: Date.now() - at });
      return { label: a.label, result, score: s };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      onEvent?.({ type: 'settle', label: a.label, accepted: false, ms: Date.now() - at, error });
      return { label: a.label, score: -Infinity, error };
    }
  }));

  const ordered = [...results].sort((a, b) => b.score - a.score);
  const top = ordered[0];
  const best = top && top.score > -Infinity && 'result' in top && top.result !== undefined
    ? { label: top.label, result: top.result as R, score: top.score }
    : undefined;

  if (best) onEvent?.({ type: 'winner', label: best.label, ms: 0 });

  return {
    best,
    ranked: ordered.map((r) => ({ label: r.label, score: r.score, error: r.error })),
  };
}
