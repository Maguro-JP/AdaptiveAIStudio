/**
 * 利用者の理想の働き方（`docs/WORK-STYLE.md`）のうち、コードで止められるもの。
 *
 * 文章でお願いせず、実行の手前で見る。ここは純粋な判定だけを置き、
 * 押し戻しや差し込みは `loop.ts` が行う。
 *
 * - 確かめた主張: 「通りました」「動きました」と言うのに、この依頼で
 *   コマンドが一度も成功していないなら、そのまま完了にしない（verify-before-done）
 * - 短い一言: 「続けて」「それも」だけの依頼は、前の依頼から読む形を渡す。
 *   聞き返させない（prompt-from-context）
 */

/**
 * 確かめたと言い切る言い回し。「完了」「終わりました」は入れない
 * （書いただけで終わる依頼もあり、それは終わりの合図で見ている）。
 */
const VERIFIED_CLAIM = /(テスト|ビルド|型チェック|試験|check|test)[^。\n]{0,12}(通りました|通った|通っています|成功しました|パスしました)|動作を確認しました|動くことを確認しました|動きました|動作確認(済み|しました)/i;

/** 確かめていないと自分で言っている、または通らなかったと言っている。 */
const HONEST_NEGATIVE = /確かめていない|確かめていません|確認していない|確認していません|見ていない|未確認|通りませんでした|失敗しました|落ちました/;

/** 返事が、確かめたと言い切っているか（自分で「確かめていない」と添えていれば言い切りではない）。 */
export function claimsVerified(text: string): boolean {
  const t = String(text ?? '');
  if (HONEST_NEGATIVE.test(t)) return false;
  return VERIFIED_CLAIM.test(t);
}

/** コマンドを走らせるツール。これの成功だけを「確かめた」の根拠に数える。 */
export const RUN_TOOLS: ReadonlySet<string> = new Set(['run_command']);

/** 根拠の無い言い切りへの押し戻し。 */
export const UNBACKED_CLAIM_NUDGE =
  'この依頼で、コマンドはまだ一度も成功していません。'
  + '確かめたと書くなら、確かめるコマンド（テストやビルド）を run_command で実行してください。'
  + '実行できないなら、返事を「確かめていない」と書き直してください。';

/** 対象も形も書かれていない一言。前の依頼から読む。 */
const SHORT_UTTERANCE = /^(やれ|やって|それも|それで|同じように|同じく|続けて|続き|続行|もう一回|もう一度|再開|直して|なおして|進めて|頼む|お願い|ok|okay|はい|うん|go|continue)[。！!.\s]*$/i;

/** 短い一言なら true。長さだけでは決めない（「npm test」は短いが、対象がある）。 */
export function isShortUtterance(text: string): boolean {
  return SHORT_UTTERANCE.test(String(text ?? '').trim());
}

/** 渡すのは前の依頼の頭だけ。長い依頼をまるごと二重に載せない。 */
const PREVIOUS_CHARS = 400;

/**
 * 今の一言が短ければ、前の依頼から読む形を返す（システムプロンプトの末尾に足す）。
 * 前の依頼が無い、または今の一言が短くなければ undefined。
 */
export function expandShortUtterance(now: string, previous: string | undefined): string | undefined {
  if (!isShortUtterance(now)) return undefined;
  const prev = String(previous ?? '').trim();
  if (!prev) return undefined;
  const head = prev.length > PREVIOUS_CHARS ? `${prev.slice(0, PREVIOUS_CHARS)}…` : prev;
  return [
    '## 今の一言の読み方',
    `今の一言「${now.trim()}」には対象が書かれていません。前の依頼の続きとして読んでください。聞き返さないでください。`,
    `前の依頼: ${head}`,
    '最初に、読んだ形（対象・やること）を ↩ で始まる1行で書いてから動いてください。',
  ].join('\n');
}
