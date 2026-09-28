/**
 * 追記式の記録（やり残し・段取り）を畳むときに、読めなかった行のうち何を残すか。
 */
/**
 * 畳むときに残す、読めなかった行。別の版が書いた行（JSON として読めて `t` を持つ）だけを、新しい方から `ODD_KEEP` 行まで。
 * 途中で切れた断片は残さない（読めないまま居座り、足すたびに畳み直すことになる）。
 */
export function keptOdd(odd: string[]): string[] {
  const records = odd.filter((l) => {
    try {
      const v = JSON.parse(l) as { t?: unknown } | null;
      return typeof v === 'object' && v !== null && typeof v.t === 'string';
    } catch { return false; }
  });
  return records.slice(-ODD_KEEP);
}

/** 畳むときに残す、別の版が書いた行の上限。 */
const ODD_KEEP = 100;
