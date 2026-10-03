/**
 * 検収 — 出てきたものを、人に見せる前に一度受け取る。
 *
 * 分解して並列に走らせられるようになると、次に困るのは
 * 「で、結局どうなったのか」が分からなくなることだ。
 * 五人が同時に動いた結果を、人が五本の作業ログから読み取るのは無理がある。
 *
 * だから間に受け取る人を置く。会社で言えば統制にあたる。
 * やることは三つ。
 *
 *   1. 誰が何をしたかを一枚にまとめる
 *   2. 出てきたものを検査に通す
 *   3. 人が見るべき点だけを挙げる
 *
 * 3 が肝。全部を人に見せるなら間に人を置く意味が無い。
 * 見なくていいものを落とし、見るべきものを落とさないのが仕事になる。
 */

export type MemberState = 'done' | 'failed' | 'skipped';

export interface MemberReport {
  id: string;
  roleId: string;
  state: MemberState;
  ms: number;
  /** 作業者の最終報告。長いので先頭だけ使う。 */
  report?: string;
  error?: string;
}

/** `unsure` は確かめたが結果が分からない（時間切れ・テストを読めない）。通ったとも落ちたとも言わない。 */
export type VerifyState = 'passed' | 'failed' | 'skipped' | 'preexisting' | 'unsure';

export interface AcceptanceInput {
  request: string;
  summary: string;
  members: MemberReport[];
  /** 実際に変わったファイル */
  changed: string[];
  /** 計画で宣言されていた書き込み先 */
  declared: string[];
  verified: VerifyState;
  verifyDetail?: string;
}

/**
 * 検収の結論。
 *
 *   accepted    人に見せてよい。指摘は無い
 *   needsHuman  人が判断すべき点がある
 *   rejected    受け取れない。巻き戻しの候補
 */
export type Verdict = 'accepted' | 'needsHuman' | 'rejected';

export interface Concern {
  /** 人が見るべき理由 */
  reason: string;
  /** どこを見ればいいか */
  where?: string[];
  severity: 'block' | 'warn';
}

export interface AcceptanceReport extends AcceptanceInput {
  verdict: Verdict;
  concerns: Concern[];
}

/**
 * 受け取れるかを判断する。
 *
 * ここはモデルを使わない。判断の根拠が毎回変わっては検収にならないし、
 * 「作った本人に採点させない」ためでもある。
 */
export function judge(input: AcceptanceInput): { verdict: Verdict; concerns: Concern[] } {
  const concerns: Concern[] = [];

  const failed = input.members.filter((m) => m.state === 'failed');
  const skipped = input.members.filter((m) => m.state === 'skipped');

  if (failed.length > 0) {
    concerns.push({
      severity: 'block',
      reason: `${failed.length}件が失敗しました。`,
      where: failed.map((m) => `${m.id}: ${m.error ?? '理由不明'}`),
    });
  }
  if (skipped.length > 0) {
    // 未実施は失敗より見落としやすい。何も起きないため。
    concerns.push({
      severity: 'warn',
      reason: `${skipped.length}件が実施されていません。依頼の一部が手つかずです。`,
      where: skipped.map((m) => `${m.id}: ${m.error ?? '理由不明'}`),
    });
  }

  if (input.verified === 'failed') {
    concerns.push({
      severity: 'block',
      reason: '検査を通っていません。',
      where: input.verifyDetail ? [input.verifyDetail] : undefined,
    });
  } else if (input.verified === 'skipped' && input.changed.length > 0) {
    concerns.push({
      severity: 'warn',
      reason: '検査していません。変更が正しいかは確かめられていません。',
    });
  } else if (input.verified === 'unsure') {
    concerns.push({
      severity: 'warn',
      reason: '確かめの結果が分かりません。変更が正しいかは確かめられていません。',
      where: input.verifyDetail ? [input.verifyDetail] : undefined,
    });
  } else if (input.verified === 'preexisting') {
    concerns.push({
      severity: 'warn',
      reason: '作業前から出ている失敗が残っています。今回の作業が原因ではありません。',
    });
  }

  // 計画外の書き換え。宣言していない場所を触るのは、
  // 「ついでに直した」か「勘違いして触った」かのどちらかで、後者が危ない。
  if (input.declared.length > 0) {
    const declared = new Set(input.declared);
    const unexpected = input.changed.filter((f) => !declared.has(f));
    if (unexpected.length > 0) {
      concerns.push({
        severity: 'warn',
        reason: `計画に無いファイルが変わっています（${unexpected.length}件）。`,
        where: unexpected,
      });
    }
  }

  // 何も変わっていない。成功に見えて何も起きていないのが一番たちが悪い。
  if (input.changed.length === 0 && failed.length === 0) {
    concerns.push({
      severity: 'warn',
      reason: '何も変わっていません。報告だけで終わっている可能性があります。',
    });
  }

  const verdict: Verdict = concerns.some((c) => c.severity === 'block')
    ? 'rejected'
    : concerns.length > 0 ? 'needsHuman' : 'accepted';

  return { verdict, concerns };
}

export function accept(input: AcceptanceInput): AcceptanceReport {
  return { ...input, ...judge(input) };
}

const VERDICT_LABEL: Record<Verdict, string> = {
  accepted: '受け取りました',
  needsHuman: '判断をお願いします',
  rejected: '受け取れません',
};

const VERIFY_LABEL: Record<VerifyState, string> = {
  passed: '通過',
  failed: '失敗',
  skipped: '未実施',
  preexisting: '元から失敗',
  unsure: '不明',
};

/** 一枚にまとめる。人が読む唯一の出力なので、ここだけ読めば済む形にする。 */
export function formatReport(r: AcceptanceReport): string {
  const lines: string[] = [];
  lines.push(`検収: ${VERDICT_LABEL[r.verdict]}`);
  lines.push(`  依頼: ${r.request}`);
  lines.push(`  方針: ${r.summary}`);

  const done = r.members.filter((m) => m.state === 'done').length;
  lines.push(`  作業: ${done}/${r.members.length}件完了 / 検査: ${VERIFY_LABEL[r.verified]}`);

  for (const m of r.members) {
    const mark = m.state === 'done' ? '✓' : m.state === 'failed' ? '✗' : '−';
    const head = (m.report ?? m.error ?? '').split('\n')[0]?.slice(0, 80) ?? '';
    lines.push(`    ${mark} [${m.id}] ${m.roleId} ${head}`);
  }

  if (r.changed.length > 0) {
    lines.push(`  変更: ${r.changed.length}件`);
    for (const f of r.changed.slice(0, 20)) lines.push(`    ${f}`);
    if (r.changed.length > 20) lines.push(`    …他 ${r.changed.length - 20}件`);
  } else {
    lines.push('  変更: なし');
  }

  if (r.concerns.length === 0) {
    lines.push('  指摘はありません。');
  } else {
    lines.push('  見ていただきたい点:');
    for (const c of r.concerns) {
      lines.push(`    [${c.severity === 'block' ? '要対応' : '確認'}] ${c.reason}`);
      for (const w of (c.where ?? []).slice(0, 5)) lines.push(`        ${w}`);
    }
  }
  return lines.join('\n');
}

/** 変わったファイルを求める。git の前後比較で、実際に何が動いたかだけを見る。 */
export function changedBetween(before: string[], after: string[]): string[] {
  const b = new Set(before);
  return after.filter((f) => !b.has(f)).sort();
}

/**
 * git が新しいフォルダとして縮めて出した道（`sub/`）のうち、書いたファイル（`sub/a.ts`）で中身が分かっているものを外す。
 * 残すと、`sub/` という無いファイルを「計画に無いファイル」として挙げ、人の判断待ちにする。書いたファイルの無いフォルダは残す
 * （計画の外で作られたもの）。
 */
export function dropCoveredDirs(changed: string[], written: string[]): string[] {
  return changed.filter((p) => !(p.endsWith('/') && written.some((w) => w.startsWith(p))));
}
