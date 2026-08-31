/**
 * 検査官にモデルを繋ぐ。
 *
 * 一件ごとに走るので、速い方を使う。判断の幅は狭く、深い推論は要らない。
 * 「関所に一番強いモデルを置く」は、体感を落とすわりに得るものが小さい。
 */
import { ChatOrchestrator } from './orchestrator.ts';
import type { ModelId } from '../providers/contract.ts';
import { Inspector, type Judge } from '../harness/inspector.ts';

/**
 * モデルを検査官として呼ぶ。
 *
 * **道具を一切渡さない。** tools を付けないことが、この役の権限が空であることの実体。
 * 会話も渡さない。一件ごとに、何も知らない状態から見る。
 */
export function createModelJudge(
  orchestrator: ChatOrchestrator,
  candidates: ModelId[],
): Judge {
  return async ({ system, user }, signal) => {
    let out = '';
    for await (const ev of orchestrator.run({
      candidates,
      system,
      messages: [{ role: 'user', content: user }],
      // 判断を揺らさない。同じ荷物には同じ答えを返してほしい。
      temperature: 0,
      // 一行しか要らない。長く書かせると、そのぶん遅くなるだけ。
      maxTokens: 200,
      // tools は渡さない。検査官は道具を持たない。
    }, signal)) {
      if (ev.type === 'text') out += ev.delta;
      else if (ev.type === 'failed') throw ev.error;
    }
    return out;
  };
}

/**
 * 検査官を用意する。使えるモデルが無ければ置かない。
 *
 * 置けなかったことを黙らせない。二段目が無いまま動いているのか、
 * 効いているのかは、利用者から見て別物なので。
 */
export function buildInspector(
  orchestrator: ChatOrchestrator,
  candidates: ModelId[],
  opts: { enabled?: boolean; timeoutMs?: number; maxChars?: number } = {},
): Inspector | undefined {
  if (opts.enabled === false) return undefined;
  if (candidates.length === 0) return undefined;
  return new Inspector({
    judge: createModelJudge(orchestrator, candidates),
    timeoutMs: opts.timeoutMs,
    maxChars: opts.maxChars,
  });
}
