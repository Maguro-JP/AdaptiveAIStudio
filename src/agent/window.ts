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
/**
 * 数える人。
 *
 * 既定は見積もり（`estimateTokens`）。そのモデルの**本物の数え方**が
 * 分かっているときは、そちらを渡す（`src/agent/tokenizer.ts`）。
 * **渡ってこないことを異常にしない。**外のモデルには GGUF が無い。
 */
export type Count = (text: string) => number;


/**
 * 頭から n 字（UTF-16 の単位）。切る所が対になる文字（絵文字・拡張漢字）の上半分なら、その手前で切る（片割れを残すと、
 * 送る JSON に対になっていない文字が入り、受ける側が断ることがある）
 */
export function headOf(text: string, n: number): string {
  if (text.length <= n) return text;
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    // 基本面の外（絵文字・拡張 B 以降の漢字）は 1 字で 2 トークン以上になる。4 字で 1 と数えて、多めに数える方針の逆に外れていた
    if (ch.length > 1) cjk += 2;
    // 漢字・かな・カナ・全角記号・ハングル・互換漢字。ここは1文字＝1トークンで数える。
    else if (/[\u1100-\u11FF\u3000-\u30FF\u3130-\u318F\u3400-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch)) cjk += 1;
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
  // **取り置きも窓に合わせる。**2200 の決め打ちは、窓 4096 では 54% になる。
  // 依頼と履歴に 90 トークンしか残らなかった（実測）。広い窓のために選んだ
  // 数字が、狭い窓では窓そのものを食う。**狭い窓ほど、この道具が要る場所。**
  const reserve = Math.max(256, Math.min(reserveTokens, Math.floor(contextTokens * 0.25)));
  return Math.max(contextTokens - reserve, 512);
}

/**
 * 履歴に使ってよいトークン数を、実際に送るシステムプロンプト（system）とツールの説明のかさを引いて決める。
 *
 * `tokenBudget` は予約一つ（コンテキストウィンドウの 25% まで）でシステムプロンプト・ツールの説明・返事のすべてを賄うつもりだったが、
 * システムプロンプト（最大 25%）とツールの説明（最大 25%）は別に足されるので、コンテキストウィンドウ 8192 では履歴 6144 にシステムプロンプトと説明を
 * 足してコンテキストウィンドウを超えていた（超えた分は、ライブラリが古い方＝最初の依頼から黙って落とすか、溢れて落ちる）。
 * 予約（`reserveTokens`）は返事の分だけにし、システムプロンプトとツールの説明は数えて引く。
 */
export function historyBudget(contextTokens: number, fixedTokens: number, reserveTokens = 2200): number {
  const reserve = Math.max(256, Math.min(reserveTokens, Math.floor(contextTokens * 0.25)));
  const fixed = Math.max(0, fixedTokens);
  const room = contextTokens - reserve - fixed;
  if (room >= 512) return room;
  // 下限 512 をそのまま返すと、システムプロンプトとツールの説明が大きいときにコンテキストウィンドウを超えていた。返事の予約から削る（返事に 256 は残す）
  return Math.max(256, Math.min(512, contextTokens - fixed - 256));
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
export function toolOutputBudget(contextTokens: number, share = 0.35, historyTokens?: number): number {
  // 履歴の取り分が分かっていれば、そこから決める（システムプロンプトとツールの説明を引いた後の取り分）
  const budget = historyTokens ?? tokenBudget(contextTokens);
  // **一つの結果が、会話ぜんぶより大きくならないようにする。**
  // 下限を 2000 の決め打ちにしていたので、窓 2048 では結果ひとつが
  // 履歴の取り分（1896）を超えていた。一度読んだ時点で溢れる。
  return Math.floor(Math.min(budget * 0.5, Math.max(2000, budget * share)));
}

/**
 * 入るだけ取る。
 *
 * **件数ではなく、長さで決める。**「新しい順に8件」のような数え方は、
 * 一件の長さが変われば意味が変わる。窓が 4k のモデルでは 8 件で半分が埋まり、
 * 32k のモデルでは 8 件では余る。
 *
 * 少なくとも `min` 件は返す（0 件にすると、そもそも効かなくなる）。
 */
export function fitByTokens<T>(
  items: readonly T[], textOf: (x: T) => string, budgetTokens: number, min = 1,
  count: Count = estimateTokens,
): T[] {
  const out: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = count(textOf(item));
    if (out.length >= min && used + cost > budgetTokens) break;
    out.push(item);
    used += cost;
  }
  return out;
}

/**
 * 道具の説明を、窓に合わせて短くする。
 *
 * 道具の説明だけで 1400 トークンほどある。**窓が 4k のモデルでは 34%。**
 * 決まりと学びを足すと、肝心の依頼と履歴の場所が残らない。
 *
 * 削るのは説明の**二文目から**。一文目は「何をする道具か」で、
 * ここを削ると呼び分けができなくなる。二文目以降は使い方の念押しなので、
 * 狭いときは落とす。**広い窓では落とさない**（説明は効くので）。
 */
/**
 * 道具の説明に使ってよい、窓の割合。
 *
 * 0.15 にしていたが、窓 4096 では 614 で、一文に切っても入らない（782）。
 * 説明が丸ごと落ちて、**何をする道具かが分からなくなる**（呼び分けができない）。
 * 前置き 25% + 道具 25% + 返事の取り置き 25% で、依頼と履歴に 25% 残る。
 */
export const TOOL_SHARE = 0.25;

export function trimSchemas<T extends { name: string; description?: string }>(
  schemas: readonly T[], contextTokens: number, share = TOOL_SHARE,
  count: Count = estimateTokens,
): T[] {
  const budget = Math.floor(contextTokens * share);
  const cost = (list: readonly T[]): number =>
    list.reduce((n, x) => n + count(JSON.stringify(x)), 0);
  if (cost(schemas) <= budget) return [...schemas];

  /*
   * **段を追って削る。**一段目で足りなければ、次の段へ。
   *
   * 一文に切るだけでは、狭い窓では足りない。窓 2048 では、切った後でも
   * 説明だけで窓の 38% を占めていた（実測）。名前と引数は残す。
   * そこが**正しく呼べるかどうか**に効く。説明は、無くても名前で分かる
   * （`read_file` `edit_file`）。会話の場所が無くなる方が痛い。
   */
  const firstSentence = schemas.map((x) => {
    const text = x.description ?? '';
    const at = text.indexOf('。');
    if (at <= 0 || at + 1 >= text.length) return x;
    return { ...x, description: text.slice(0, at + 1) };
  });
  if (cost(firstSentence) <= budget) return firstSentence;

  const noDescription = schemas.map((x) => {
    const { description: _drop, ...rest } = x;
    return rest as T;
  });
  if (cost(noDescription) <= budget) return noDescription;

  // 引数の説明まで落とす。ここが底。**説明だけを抜く。**
  return noDescription.map((x) => {
    const params = (x as { parameters?: unknown }).parameters;
    if (params === undefined) return x;
    return { ...x, parameters: stripDescriptions(params) } as T;
  });
}

/**
 * 説明だけを、深いところまで抜く。
 *
 * **形は残す。**`{ type }` に組み直していたので、`enum` `items` `required`
 * `default` が落ちていた。手元の道具は type と description しか持たないので
 * 気づかないが、**MCP で外から来る道具は持っている。**落とすと、モデルは
 * 通らない引数を作り、相手に断られる。減らしたいのは説明であって、形ではない。
 */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'description') continue;
    out[k] = stripDescriptions(v);
  }
  return out;
}

/** かさ（トークンの見積もり）。 */
/**
 * トークンで測って、頭から入る分だけ切る。
 *
 * ここまで、道具の返しは**トークンの予算を文字数と突き合わせて**いた。
 * 単位が違うので、日本語ではたまたま合い、英語では**4分の1しか使えて
 * いなかった**（窓が余っているのに、読んだファイルが途中で切れる）。
 *
 * 数えるのは安くないので、頭から一文字ずつは試さない。**挟み撃ちで探す。**
 * 行の切れ目に寄せる（途中で切ると、その行が別の意味になる）。
 */
export function cutToTokens(text: string, budget: number, count: Count = estimateTokens): string {
  if (budget <= 0) return '';
  if (count(text) <= budget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (count(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const cut = text.slice(0, lo);
  const nl = cut.lastIndexOf('\n');
  return nl > 0 ? cut.slice(0, nl) : cut;
}

/** 1 通ごとの包み（チャットテンプレートの役割のタグと区切り）に見込むトークン数。 */
const MESSAGE_OVERHEAD = 4;

export function sizeOf(
  messages: readonly ProviderMessage[], count: Count = estimateTokens,
): number {
  let n = 0;
  for (const m of messages) {
    // 1 通ごとの包み（役割のタグ・区切り）の分。数えていなかったので、ツールの往復が多いほど少なく見ていた
    n += MESSAGE_OVERHEAD;
    n += count(m.content);
    for (const c of m.toolCalls ?? []) n += count(c.name + JSON.stringify(c.args ?? {}));
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
  count: Count = estimateTokens,
): { messages: ProviderMessage[]; trimmed: boolean; dropped: number } {
  /*
   * **入り切らないものを、測らない。**
   *
   * ここまで、毎回すべての履歴を数え直していた。半年ひとつの会話を続けると
   * 14,400 通・16.6MB になり、**一往復あたり 1.2 秒**（本物の数え方なら
   * 2.1 秒）を刈り込みだけに使っていた。残すのは 18 通なのに、16MB を測る。
   *
   * **使うほど遅くなる。**それは、使うほど馬鹿になるのと同じこと。
   *
   * 残すのは「最初の依頼」と「直近」だけ、と決まっている。だから、
   * **後ろから見て、入る見込みの所で切ってから**本来の刈り込みへ渡す。
   * 全部が入るときは何も変わらない（この足切りは効かない）。
   */
  const near = tailWithin(history, budget, count);
  let cut = 0;
  let work = history;
  let cutPaths: string[] = [];
  // 直近の分が最初の依頼より後ろから始まるときだけ、足切りする。最初の依頼から始まるなら（頭に挨拶や要約が置かれて
  // いても全部入る形）、最初の依頼を二度並べ、頭の発言を知らせも無く落としていた
  const start = history.length - near.length;
  const firstAt = history.findIndex((m) => m.role === 'user');
  if (near.length < history.length && start > firstAt) {
    const first = firstRequest(history, count, budget);
    work = [...first, ...near];
    cut = history.length - work.length;
    /*
     * **ここで落とした分にも、印を付ける。**
     *
     * 数は返していたが、**モデルへ渡す並びには何も残していなかった**。
     * 道具を使わない往復が続くと、この速い道だけで落ちる。実測で
     * 22 往復が印も無く消えていた。落ちた側から見ると、最初の依頼の次が
     * いきなり最新になっていて、間に何があったのか分からない。
     *
     * 道を拾うのは、末尾に近い方から少しだけ（ここは「測らない」ための道で、
     * 全部を舐めると速さの意味が無くなる）。
     */
    // 落とした分は、最初の依頼の後ろから直近の手前まで（頭に依頼以外があれば、それも落とした分に数える）
    const gone = [...history.slice(0, Math.max(0, firstAt)), ...history.slice(first.length > 0 ? firstAt + 1 : Math.max(0, firstAt), start)];
    cutPaths = pathsIn(gone.slice(-SCAN_FOR_PATHS));
  }
  return fitCore(work, budget, count, cut, cutPaths);
}

/** 本来の刈り込み。**入る見込みのものだけが渡ってくる。** */
function fitCore(
  history: readonly ProviderMessage[],
  budget: number,
  count: Count,
  already = 0,
  alreadyPaths: readonly string[] = [],
): { messages: ProviderMessage[]; trimmed: boolean; dropped: number } {
  if (sizeOf(history, count) <= budget && already === 0) {
    return { messages: [...history], trimmed: false, dropped: 0 };
  }

  const units = toUnits(history, count);
  // 最初の依頼は落とさない。直近も落とさない。
  const firstAt = units.findIndex((u) => u.messages[0]?.role === 'user');
  const keepFirst = firstAt >= 0 ? firstAt : 0;
  const recentFrom = Math.max(units.length - KEEP_RECENT, keepFirst + 1);
  /*
   * 今の依頼（最後の人の発言。押し戻しは除く）も落とさない。最初の依頼と直近 3 往復だけを守っていたので、同じ会話の
   * 2 件目の依頼のあとにツールの往復が続くと、2 件目の依頼が落ち、モデルは最初の依頼の続きをしていた
   */
  let askAt = -1;
  for (let i = units.length - 1; i > keepFirst; i -= 1) {
    const head = units[i]!.messages[0];
    if (head?.role === 'user' && head.nudge !== true) { askAt = i; break; }
  }
  const ask = askAt >= 0 ? units[askAt] : undefined;

  // まず、古い道具の結果を縮める。かさの大半はこれ。
  let shrunk = false;
  for (let i = keepFirst + 1; i < recentFrom; i += 1) {
    const u = units[i]!;
    u.messages = u.messages.map((m) => {
      if (m.role !== 'tool' || m.content.length <= KEEP_HEAD) return m;
      shrunk = true;
      const cut = m.content.length - KEEP_HEAD;
      return { ...m, content: `${headOf(m.content, KEEP_HEAD)}\n…（この先 ${cut} 字は、文脈に収まらないので省いています）` };
    });
    u.chars = sizeOf(u.messages, count);
  }

  // それでも溢れるなら、古い往復を丸ごと落とす。
  // **どのファイルを触ったかだけは、落とす前に控える。**数だけ残しても、
  // モデルは同じ所をもう一度読みに行く（Claude Code の compaction が
  // 「どのファイルで作業しているか」を残しているのと同じ理由）。
  let dropped = 0;
  const touched: string[] = [...alreadyPaths];
  let at = keepFirst + 1;
  while (total(units) > budget && at < recentFrom - dropped) {
    if (units[at] === ask) { at += 1; continue; }
    for (const path of pathsIn(units[at]!.messages)) {
      if (!touched.includes(path)) touched.push(path);
    }
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
        return { ...m, content: `${headOf(m.content, KEEP_LAST_RESORT)}\n…（この先 ${cut} 字は、文脈に収まらないので省いています）` };
      });
      u.chars = sizeOf(u.messages, count);
    }
  }

  // それでも溢れるなら、守っている依頼（最初と今）の本文も頭だけ残して縮める。守ったまま予算を超えて返していた（添付を差し込んだ大きな依頼など）
  for (const keep of [ask, units[keepFirst]]) {
    const over = total(units) - budget;
    if (over <= 0) break;
    if (!keep) continue;
    keep.messages = keep.messages.map((m) => {
      if (m.role !== 'user') return m;
      const room = Math.max(KEEP_HEAD, count(m.content) - over - 40);
      const cut = cutToTokens(m.content, room, count);
      if (cut.length >= m.content.length) return m;
      shrunk = true;
      return { ...m, content: `${cut}\n…（この先 ${m.content.length - cut.length} 字は、文脈に収まらないので省いています）` };
    });
    keep.chars = sizeOf(keep.messages, count);
  }

  const out: ProviderMessage[] = [];
  for (const [i, u] of units.entries()) {
    out.push(...u.messages);
    // 落とした場所に、落としたと書く。**黙って落とさない。**
    if (dropped + already > 0 && i === keepFirst) {
      out.push({
        role: 'user',
        content: `（このあと ${dropped + already} 往復ぶんは、文脈に収まらないので省いています。`
          + (touched.length > 0 ? `そこで触ったのは ${touched.slice(0, 5).join('、')} です。` : '')
          + '必要なら、もう一度読み直してください。）',
      });
    }
  }
  return { messages: out, trimmed: shrunk || dropped + already > 0, dropped: dropped + already };
}

/**
 * 落とす往復から、触ったファイルの道を拾う。
 *
 * 道具の引数（`{"path":"src/x.ts"}`）から取る。**数だけ残しても、
 * モデルは同じ所をもう一度読みに行く。**どこを触ったかが分かれば、
 * 読み直すにしても当てが付く。
 */
const SCAN_FOR_PATHS = 200;

function pathsIn(messages: readonly ProviderMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) {
      // 引数は JSON として妥当とは限らない（モデルが作る）。触って落ちない形で読む。
      const args = call.args as { path?: unknown } | undefined;
      const path = typeof args?.path === 'string' ? args.path : undefined;
      if (path && path.length <= 120 && !out.includes(path)) out.push(path);
    }
  }
  return out;
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
/**
 * 後ろから、予算の何倍かに収まるところまで。
 *
 * **切りすぎない。**刈り込みの本体は、道具の結果を縮めたり往復を落としたり
 * するので、予算ちょうどで切ると縮めれば入るものまで捨てる。
 * 余裕を持って多めに残し、判断は本体に任せる。
 *
 * 往復の切れ目（人の発言）で切る。道具の呼び出しと結果を割ると、
 * 相手が形の違うものを受け取って落ちる。
 */
function tailWithin(
  history: readonly ProviderMessage[], budget: number, count: Count,
): ProviderMessage[] {
  const room = budget * 4;
  let used = 0;
  // 切るのは人の依頼の手前（その依頼を含める）。依頼の後ろで切っていたので、並びが assistant から始まり、
  // 今の依頼の往復が長いと今の依頼そのものが消えていた。押し戻しの手前では切らない（その前の本物の依頼まで含める）
  let at = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    used += sizeOf([history[i]!], count);
    const m = history[i]!;
    if (m.role === 'user' && m.nudge !== true) {
      at = i;
      if (used > room) break;
    }
  }
  return at < 0 ? [...history] : history.slice(at);
}

/** 最初の依頼（と、その一往復）。**何をしているのかが消えないように。** */
function firstRequest(
  history: readonly ProviderMessage[], count: Count, budget: number,
): ProviderMessage[] {
  const at = history.findIndex((m) => m.role === 'user');
  if (at < 0) return [];
  const one = [history[at]!];
  // 長すぎる最初の依頼で予算を食い潰さない。入らないなら連れて行かない。
  return sizeOf(one, count) <= budget * 0.5 ? one : [];
}

function toUnits(history: readonly ProviderMessage[], count: Count = estimateTokens): Unit[] {
  const units: Unit[] = [];
  let current: ProviderMessage[] = [];
  const flush = () => {
    if (current.length > 0) { units.push({ messages: current, chars: sizeOf(current, count) }); current = []; }
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
