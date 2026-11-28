/**
 * 手元のモデルで、札の文を磨く・選ぶ（IDEAMAN の ideaman/engine/refiner.py の考え方）。
 *
 * 札は、モデルが無くても出る。ここは、在るときだけ通す仕上げで、頼む文を作る所と、返事を読む所だけを持つ
 * （モデルを呼ぶのは画面の本体）。返事が決めた形でなければ、その札は元の文のままにする。投げない。
 */

export interface PolishCard { id: string; text: string; material?: string }

export const POLISH_SYSTEM = [
  'あなたは、アイデアの札の文を短い日本語に整える編集者です。質問に答える係ではありません。',
  '守ること:',
  '- 番号の付いた文を、同じ番号のまま 1 行ずつ整える。新しい題材を足さない。材料の語は変えない。',
  '- 1 行は 1〜2 文。解説・箇条書き・かぎ括弧は書かない。提案は提案のまま、問いは問いのままにする。',
  '- 最後の行に、いちばん試す値打ちのある札の番号を BEST に続けて書く。',
  '出力は、次の形だけ（札が 2 枚のときの例。「…」の所に整えた文を書く）:',
  '1: …',
  '2: …',
  'BEST: 2',
].join('\n');

/** 仕上がりが元の何倍までなら受けるか。大きく超えたら、解説が混ざっている。 */
export const MAX_GROWTH = 2.5;
const SUSPICIOUS = ['<', '```', '- ', '* '];

export function polishPrompt(cards: readonly PolishCard[]): string {
  return cards.map((c, i) => `${i + 1}: ${c.text}`).join('\n');
}

/** モデルの返事を読む。読めた行だけを返す（番号が無い・長すぎる・材料の語が消えた・記号が混ざった行は捨てる）。 */
export function parsePolish(output: string, cards: readonly PolishCard[]): { texts: Record<string, string>; best?: string } {
  const texts: Record<string, string> = {};
  let best: string | undefined;
  // 考えごとの段（<think>…</think>）は読まない
  const body = output.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '');
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const pick = /^BEST\s*[:：]\s*(\d+)/i.exec(line);
    if (pick) {
      const card = cards[Number(pick[1]) - 1];
      if (card) best = card.id;
      continue;
    }
    const m = /^(\d+)\s*[:：.．]\s*(.+)$/.exec(line);
    if (!m) continue;
    const card = cards[Number(m[1]) - 1];
    const text = m[2]!.trim();
    // 空白を足しただけの文は、磨いたうちに入れない（本物の 4B が、英字の前後に空白を足しただけの文を返した）
    if (!card || text.replace(/\s+/g, '') === card.text.replace(/\s+/g, '')) continue;
    if (text.length > card.text.length * MAX_GROWTH || text.length < card.text.length * 0.4) continue;
    if (SUSPICIOUS.some((s) => text.includes(s))) continue;
    if (card.material && !text.includes(card.material)) continue;
    texts[card.id] = text;
  }
  return best ? { texts, best } : { texts };
}
