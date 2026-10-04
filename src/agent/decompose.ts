/**
 * 依頼を、歩ける大きさの段に割る。
 *
 * **モデルに割らせる。ただし信用しない。**
 * 小さいモデルは平気で壊れたものを返す。番号だけ、空の行、
 * 「以下の手順で進めます」という前置き、丸ごと日本語の作文。
 * 読めないなら**割らないで進む**（割れないことは、進めない理由にならない）。
 *
 * 歩幅（`stride.ts`）で、割り方の細かさを変える。
 * ここが「その機械のそのモデルに合わせる」の実体。
 */
import type { ChatOrchestrator } from '../core/orchestrator.ts';
import { guideFor, type StrideSize } from './stride.ts';

/** 一段の言葉として、長すぎるもの・短すぎるものは捨てる。 */
const MIN_CHARS = 4;
const MAX_CHARS = 200;

export interface DecomposeOptions {
  candidates: string[];
  request: string;
  size: StrideSize;
  /** これまでに分かっていること（前回どこで落ちたか等）。 */
  note?: string;
  signal: AbortSignal;
}

/**
 * 割る。読めなければ空を返す（**呼ぶ側は、空なら割らずに進む**）。
 */
export async function decompose(
  orchestrator: ChatOrchestrator, opts: DecomposeOptions,
): Promise<string[]> {
  const guide = guideFor(opts.size);
  const system = [
    'あなたは、依頼を「一歩ずつ実行できる段」に割る担当です。',
    '',
    '## 割り方',
    guide.text,
    `段は ${guide.steps} 個までにしてください。少ないぶんには構いません。`,
    '前の段が終わっていれば、次の段だけを読んで実行できること。',
    '',
    '## 書き方',
    '1行に1段。番号も記号も付けない。前置きも要らない。',
    '段そのものだけを、上から順に書いてください。',
  ].join('\n');

  const asked = [
    `依頼: ${opts.request}`,
    ...(opts.note ? ['', `前回の様子: ${opts.note}`] : []),
  ].join('\n');

  let text = '';
  try {
    for await (const ev of orchestrator.run(
      { candidates: opts.candidates, system, messages: [{ role: 'user', content: asked }] },
      opts.signal,
    )) {
      if (ev.type === 'text') text += ev.delta;
      // 途中で落ちた・上限で切れた返事は、最後の段が切れている（「src/b.ts の bar を」のまま段にしていた）。
      // 投げずに出来事で知らせてくるので、ここで見る。割れないことは、進めない理由にならない
      if (ev.type === 'failed') return [];
      if (ev.type === 'done' && ev.finishReason === 'length') return [];
    }
  } catch {
    return []; // 割れないことは、進めない理由にならない
  }
  return readSteps(text, guide.steps);
}

/**
 * 返ってきたものから、段を拾う。
 *
 * **形を整えさせるより、こちらで拾う。**小さいモデルに書式を守らせる
 * のは高くつく（守らせようとするほど、中身が薄くなる）。
 */
export function readSteps(text: string, max: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (line.length === 0) continue;
    if (/^```/.test(line)) continue;
    // 番号・記号・強調（`**手順:**`）を落とす（付けるなと言っても付けてくる）。
    line = line.replace(/^[-*・>]+\s*/, '').replace(/^\(?\d+[.)、）]\s*/, '').replace(/\*\*|__/g, '').trim();
    // 見出し・導入・結びは落とす。記号を落とした後に見る（前に見ていたので、`- 以下の順で` や `**手順:**` を段にしていた）
    if (/^(#|以下|まず以下|手順|段取り|計画)/.test(line)) continue;
    if (/^(以上|これで)/.test(line)) continue;
    // 終わりの合図が混ざってくることがある。段ではない。
    if (line === 'TASK_DONE') continue;
    if (line.length < MIN_CHARS || line.length > MAX_CHARS) continue;
    if (out.includes(line)) continue; // 同じ段を二度出してくる
    out.push(line);
  }
  // 決めた数より多く返ってきたら、割らずに進ませる。頭から拾って残りを捨てると、捨てた段は一度も行われないまま
  // 依頼を「済んだ」で閉じていた（段の頼み文は「ほかの段には手を出さない」なので、誰も拾わない）
  if (out.length > max) return [];
  // 1段しか拾えないなら、割れていないのと同じ。**割らずに進ませる。**
  return out.length >= 2 ? out : [];
}

/** 一段を頼む文。**その段だけを見て実行できる形にする。** */
export function stepPrompt(request: string, instruction: string, at: number, total: number): string {
  return [
    `いまの依頼: ${request}`,
    '',
    `この一歩（${at}/${total}）だけをやってください: ${instruction}`,
    '',
    'ほかの段には手を出さないでください。この一歩が終わったら、そこで終わりです。',
  ].join('\n');
}
