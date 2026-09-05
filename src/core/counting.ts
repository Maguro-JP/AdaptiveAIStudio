/**
 * トークンをどう数えるかを、一箇所で決める。
 *
 * 決め方が会話の土台（session）の中にしか無いと、**点検（doctor）から見えない。**
 * 本物で数えているのか見積もりなのかは、窓の勘定の精度そのもので、
 * 見えないと、切れ方がおかしいときに「モデルが悪い」としか言えない。
 *
 * 決め方を二箇所に書くと、片方だけ直して食い違う。ここだけに書く。
 */
import { join } from 'node:path';
import { counterForGguf, type Counter } from '../agent/tokenizer.ts';
import { readGguf } from '../runtime/gguf.ts';
import { listGguf } from '../runtime/inproc.ts';
import { modelsDir } from './home.ts';
import type { AasConfig } from '../config.ts';

export interface Counting {
  counter?: Counter;
  /** 数え方を取ったファイル。分かったときだけ。 */
  file?: string;
  /** 人に見せる一行。**見積もりに戻った理由まで言う。** */
  why: string;
}

/**
 * どう数えるかを決める。
 *
 * **当てずっぽうに一つ選ばない。**複数あって決められないときは見積もりに戻る。
 * 別のモデルの数え方で数えるくらいなら、粗いほうがまだ読める。
 */
export async function resolveCounting(config: AasConfig): Promise<Counting> {
  const rc = config.runtime ?? {};
  if (rc.kind !== 'inproc') {
    return { why: '見積もり（この中で読む道ではないので、語彙が分かりません）' };
  }
  const dir = rc.modelsDir ?? modelsDir();

  // 候補の名前からは引けないことがある（ollama の名前で並ぶ）。
  // 名前で分かるならそれを使い、分からなければ置き場を見る。
  const named = (config.candidates ?? []).find((c) => /\.gguf$/i.test(c));
  let file = named ? named.split(/[:\\/]/).pop() : undefined;
  if (!file) {
    const found = await listGguf(dir).catch(() => []);
    if (found.length === 1) file = found[0]!.ref;
    else if (found.length > 1) {
      return { why: `見積もり（GGUF が ${found.length} 個あって、どれを読むか決まりません）` };
    }
  }
  if (!file) return { why: '見積もり（GGUF がありません）' };

  const counter = await counterForGguf(join(dir, file), readGguf);
  if (!counter) return { file, why: `見積もり（${file} の語彙を読めませんでした）` };
  return { counter, file, why: `本物（${file} に書いてある通りに数えます）` };
}
