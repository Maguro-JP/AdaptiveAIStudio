/**
 * ブラウザを開く命令の名前。
 *
 * **`process.platform` を直に見ない。**直に見ると、Linux で走らせている限り
 * Windows と macOS の分岐が一度も通らず、配ってから初めて動く。渡せる形にして、
 * どの OS ぶんもここで試せるようにする（`test/opener.test.ts`）。
 */
import { dirname } from 'node:path';

export function openerFor(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'explorer';
  return 'xdg-open';
}

/**
 * ファイルやフォルダを、OS で開いて見せる命令。
 *
 * ファイルは**そのファイルを選んだ状態でフォルダを開く**（Windows の `/select,`、
 * macOS の `-R`）。ファイルそのものを開くと、関連付けられたアプリが立ち上がって
 * 「場所を確かめたい」のに別のものが出る。Linux はフォルダを開くだけ。
 */
export function revealCommand(
  platform: NodeJS.Platform, target: string, isDir: boolean,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return isDir ? { command: 'explorer', args: [target] } : { command: 'explorer', args: [`/select,${target}`] };
  }
  if (platform === 'darwin') {
    return isDir ? { command: 'open', args: [target] } : { command: 'open', args: ['-R', target] };
  }
  return { command: 'xdg-open', args: [isDir ? target : dirname(target)] };
}
