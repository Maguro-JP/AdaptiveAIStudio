const PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{16,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
];

/** ログ・エクスポート・エラー本文からAPIキーらしき文字列を落とす (R8)。 */
export function redact(input: string): string {
  return PATTERNS.reduce((s, re) => s.replace(re, '***REDACTED***'), input);
}
