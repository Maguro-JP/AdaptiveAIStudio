/**
 * テスト（`scripts/run-tests.mjs`）が通ったか。
 *
 * `# fail 0` の行だけで決めていたので、時間切れで打ち切られた試験（node:test は fail ではなく `# cancelled` に数え、終了コードは 1）や、
 * 走らせ役が 1 で終えた回（設定を書き換えた、など）を「通った」と言っていた。終了コードも、打ち切りの数も見る。
 */
export function testsPassed(text: string, code: number | null): boolean {
  return code === 0 && /^# fail 0$/m.test(text) && !/^# cancelled [1-9]/m.test(text);
}
