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
import { listGguf, chooseModel } from '../runtime/inproc.ts';
import { totalmem } from 'node:os';
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

  /*
   * どの GGUF を読むか。**土台と同じ決め方をする。**
   *
   * 決め方が二つあると、別のモデルの数え方で数えることになる。
   * 土台（`#readyToThink`）は「設定で決めた名前があればそれ、無ければ
   * 置き場の最初の一つ」で選ぶ。ここも同じ順で見る。
   *
   * 候補（candidates）からは引かない。ollama の名前で並ぶことがあり、
   * 実際に読むファイルとは別（これで一度、繋がっていないのに繋がった気で
   * いた）。
   */
  const found = await listGguf(dir).catch(() => []);
  const wanted = rc.model;
  let file = wanted ? found.find((m) => m.ref === wanted)?.ref : undefined;
  if (!file) {
    const named = (config.candidates ?? []).find((c) => /\.gguf$/i.test(c));
    file = named ? named.split(/[:\\/]/).pop() : undefined;
  }
  if (!file) {
    if (found.length === 1) file = found[0]!.ref;
    else if (found.length > 1) {
      // runtime と**同じものを見る。**runtime は大きさと機械で選ぶ（\`chooseModel\`）ので、名前の先頭を取ると別のモデルの数え方を
      // 「本物」と見せていた。ここで諦めると、二つ置いてあるだけで見積もりに落ちる。GPU の有無はここでは分からない（GPU 無しとして選ぶ）
      file = chooseModel(found, totalmem())?.chosen.ref ?? found[0]!.ref;
    }
  }
  if (!file) return { why: '見積もり（GGUF がありません）' };

  const counter = await counterForGguf(join(dir, file), readGguf);
  if (!counter) return { file, why: `見積もり（${file} の語彙を読めませんでした）` };
  return { counter, file, why: `本物（${file} に書いてある通りに数えます）` };
}
