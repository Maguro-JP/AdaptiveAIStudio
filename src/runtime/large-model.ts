/**
 * 確かめで押し戻された頼みを回す、大きいモデルを選ぶ（docs/NETWORK-MODEL.md の「大きいモデルは要るときだけ」）。
 *
 * 既定は、取ってある中で、今のモデルより大きく、この機械の計画で動くもののうち、いちばん大きいもの。
 * 設定（`escalate.model`）で名前を決めてあれば、それ。置いて無い・計画で動かないときは、選ばずに理由を返す（1 行で言うため）。
 * **ここは選ぶだけ。**ファイルも機械も読まない（動くかどうかは、呼ぶ側が `canRun` で答える）。
 */
export interface LargeCandidate {
  ref: string;
  sizeBytes?: number;
}

export type LargePick =
  | { ref: string; why?: undefined }
  | { ref?: undefined; why: string };

export async function pickLargeModel(o: {
  models: readonly LargeCandidate[];
  /** いま使っているモデル。これより大きいものだけを「大きい」とする。 */
  current?: string;
  /** 設定で決めた名前。 */
  wanted?: string;
  /** この機械の計画で動くか。 */
  canRun: (m: LargeCandidate) => Promise<boolean>;
}): Promise<LargePick> {
  const size = (m: LargeCandidate): number => m.sizeBytes ?? 0;
  if (o.wanted) {
    const named = o.models.find((m) => m.ref === o.wanted);
    if (!named) return { why: `設定で決めた大きいモデル（${o.wanted}）が置いてありません` };
    if (named.ref === o.current) return { why: `設定で決めた大きいモデル（${o.wanted}）は、今のモデルです` };
    if (!(await o.canRun(named))) return { why: `設定で決めた大きいモデル（${o.wanted}）は、この PC の計画では動きません` };
    return { ref: named.ref };
  }
  const now = o.models.find((m) => m.ref === o.current);
  const bigger = o.models
    .filter((m) => m.ref !== o.current && size(m) > (now ? size(now) : 0))
    .sort((a, b) => size(b) - size(a));
  if (bigger.length === 0) return { why: '今のモデルより大きいモデルが置いてありません' };
  for (const m of bigger) if (await o.canRun(m)) return { ref: m.ref };
  return { why: `大きいモデル（${bigger[0]!.ref}）は、この PC の計画では動きません` };
}
