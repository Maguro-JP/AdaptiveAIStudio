/**
 * 文脈の窓に、履歴を収める。
 *
 * ここまで、履歴は**一度も刈っていなかった**。外の大きなモデルなら
 * 何十万字でも入るので、それで済んでいた。ローカルは違う。
 * 会社の機械に載る大きさだと窓は 8192。ファイルを2つ3つ読んだ時点で
 * 溢れる。
 *
 * 溢れたときに何が起きるかが、いちばん悪い。ライブラリは**古い方から
 * 黙って落とす**（contextShift）。落ちるのは、いちばん古いもの
 * ＝**最初の依頼**。何をしていたのかを忘れたまま、道具だけを呼び続ける。
 * 止まらないので気づけない。自律で回すほど、確実にここへ来る。
 *
 * だから、こちらで決めて刈る。
 *
 *   1. 最初の依頼は落とさない（何をしているのかが消える）
 *   2. 直近のやりとりは落とさない（いま何をしているかが消える）
 *   3. 減らすのは、まず**古い道具の結果**（かさの大半はこれ）
 *   4. それでも溢れるなら、古い往復を丸ごと落とし、落としたと書く
 *
 * **黙って落とさない。**落としたことを本文に残す。残さないと、
 * モデルは「読んだはずのもの」を読んでいないまま話を進める。
 */
import type { ProviderMessage } from '../providers/contract.ts';

/**
 * 一往復のかたまり。
 *
 * 道具を呼んだ assistant と、その結果の tool は**離せない**。
 * 片方だけ落とすと、相手（provider）が形の違うものを受け取って落ちる。
 * 「結果だけあって、呼び出しが無い」は、OpenAI 互換の口では通らない。
 */
interface Unit {
  messages: ProviderMessage[];
  chars: number;
}

/**
 * 文字数からトークン数を見積もる。
 *
 * **一つの係数で済ませない。**日本語と英語で、まったく違う。
 *
 *   英語   … 4文字ほどで1トークン
 *   日本語 … 1文字でほぼ1トークン（漢字は1文字で1〜2）
 *
 * ここを 2.5 の一本値にしていたので、**日本語では2倍以上入ると
 * 見積もっていた。**入らない分は窓から溢れ、途中で落ちる
 * （画面には「打っても返事が来ない」として出る）。
 *
 * 正確に数えるには字句器が要るが、字句器はモデルごとに違う。
 * ここでは**外す向きを決めて**粗く見る。**多めに数える**（溢れるより余る）。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    // 漢字・かな・カナ・全角記号。ここは1文字＝1トークンで数える。
    if (/[\u3000-\u30FF\u3400-\u9FFF\uFF00-\uFFEF]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

/** 道具の結果を縮めるときに、頭に残す長さ。 */
const KEEP_HEAD = 400;

/** 直近いくつの往復は、真っ先には縮めないか。 */
const KEEP_RECENT = 3;

/**
 * 最後の手段で、直近を縮めるときに残す長さ。
 *
 * 古い分より多く残す。いま見ているものなので、頭だけでは足りない。
 */
const KEEP_LAST_RESORT = 1200;

/**
 * 窓（トークン）から、履歴に使ってよいトークン数を決める。
 *
 * 差し引くのは、決まり（system）・道具の説明・これから書く分。
 * 決まりには「二度としないこと」も載るので、少なめには見ない。
 */
export function tokenBudget(contextTokens: number, reserveTokens = 2200): number {
  return Math.max(contextTokens - reserveTokens, 512);
}

/**
 * 道具の返しに使ってよい長さ（文字）。
 *
 * **窓から決める。**`read_file` は最大 40万字を丸ごと返していた。
 * 窓が 8k のモデルでは、一度読んだだけで溢れる。
 * 刈る側は後から縮められるが、そのときには**中身がほとんど残らない**
 * （直近の道具の結果は 1200 字まで削られる）。読む時点で収めておく。
 *
 * 文字で返すのは、切り出しが文字単位のため。日本語は1文字1トークンなので、
 * 文字数をそのままトークン数と見て安全側に倒す。
 */
export function toolOutputBudget(contextTokens: number, share = 0.35): number {
  return Math.max(2000, Math.floor(tokenBudget(contextTokens) * share));
}

/** かさ（トークンの見積もり）。 */
export function sizeOf(messages: readonly ProviderMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += estimateTokens(m.content);
    for (const c of m.toolCalls ?? []) n += estimateTokens(c.name + JSON.stringify(c.args ?? {}));
  }
  return n;
}

/**
 * 窓に収まる形にして返す。**元は変えない。**
 *
 * 元を書き換えると、残してある会話まで欠ける。送る分だけを作る。
 */
export function fitToWindow(
  history: readonly ProviderMessage[],
  budget: number,
): { messages: ProviderMessage[]; trimmed: boolean; dropped: number } {
  if (sizeOf(history) <= budget) {
    return { messages: [...history], trimmed: false, dropped: 0 };
  }

  const units = toUnits(history);
  // 最初の依頼は落とさない。直近も落とさない。
  const firstAt = units.findIndex((u) => u.messages[0]?.role === 'user');
  const keepFirst = firstAt >= 0 ? firstAt : 0;
  const recentFrom = Math.max(units.length - KEEP_RECENT, keepFirst + 1);

  // まず、古い道具の結果を縮める。かさの大半はこれ。
  let shrunk = false;
  for (let i = keepFirst + 1; i < recentFrom; i += 1) {
    const u = units[i]!;
    u.messages = u.messages.map((m) => {
      if (m.role !== 'tool' || m.content.length <= KEEP_HEAD) return m;
      shrunk = true;
      const cut = m.content.length - KEEP_HEAD;
      return { ...m, content: `${m.content.slice(0, KEEP_HEAD)}\n…（この先 ${cut} 字は、文脈に収まらないので省いています）` };
    });
    u.chars = sizeOf(u.messages);
  }

  // それでも溢れるなら、古い往復を丸ごと落とす。
  let dropped = 0;
  let at = keepFirst + 1;
  while (total(units) > budget && at < recentFrom - dropped) {
    units.splice(at, 1);
    dropped += 1;
  }

  // それでも溢れるなら、直近も縮める。**落とすより縮める。**
  // 落とすと往復の筋そのものが消えるが、縮めれば「何をしたか」は残る。
  if (total(units) > budget) {
    for (let i = units.length - 1; i >= 0; i -= 1) {
      if (total(units) <= budget) break;
      const u = units[i]!;
      u.messages = u.messages.map((m) => {
        if (m.role !== 'tool' || m.content.length <= KEEP_LAST_RESORT) return m;
        shrunk = true;
        const cut = m.content.length - KEEP_LAST_RESORT;
        return { ...m, content: `${m.content.slice(0, KEEP_LAST_RESORT)}\n…（この先 ${cut} 字は、文脈に収まらないので省いています）` };
      });
      u.chars = sizeOf(u.messages);
    }
  }

  const out: ProviderMessage[] = [];
  for (const [i, u] of units.entries()) {
    out.push(...u.messages);
    // 落とした場所に、落としたと書く。**黙って落とさない。**
    if (dropped > 0 && i === keepFirst) {
      out.push({
        role: 'user',
        content: `（このあと ${dropped} 往復ぶんは、文脈に収まらないので省いています。`
          + '必要なら、もう一度読み直してください。）',
      });
    }
  }
  return { messages: out, trimmed: shrunk || dropped > 0, dropped };
}

function total(units: readonly Unit[]): number {
  let n = 0;
  for (const u of units) n += u.chars;
  return n;
}

/**
 * 往復のかたまりに分ける。
 *
 * 道具を呼んだ assistant には、その結果の tool を必ず連れて行かせる。
 */
function toUnits(history: readonly ProviderMessage[]): Unit[] {
  const units: Unit[] = [];
  let current: ProviderMessage[] = [];
  const flush = () => {
    if (current.length > 0) { units.push({ messages: current, chars: sizeOf(current) }); current = []; }
  };
  for (const m of history) {
    if (m.role === 'tool') {
      // 直前の assistant にくっつける。単独では置かない。
      if (current.length === 0 && units.length > 0) current = units.pop()!.messages;
      current.push(m);
      continue;
    }
    flush();
    current.push(m);
  }
  flush();
  return units;
}
