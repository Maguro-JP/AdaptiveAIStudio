/**
 * ブラウザを開く命令の名前。
 *
 * **`process.platform` を直に見ない。**直に見ると、Linux で走らせている限り
 * Windows と macOS の枝が一度も通らず、配ってから初めて動く。渡せる形にして、
 * どの OS ぶんもここで試せるようにする（`test/opener.test.ts`）。
 */
export function openerFor(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'explorer';
  return 'xdg-open';
}
