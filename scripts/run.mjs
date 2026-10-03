/**
 * npm が無くても、決めた仕事を動かす。
 *
 * 持ち運び版には node.exe だけを同梱したい（npm まで入れると重くなる）。
 * ところが起動用は `npm run <名前>` を呼んでいたので、npm が要る作りだった。
 *
 * かといって、起動用の中に「ui なら src/cli/ui.ts」と書き写すと、
 * package.json と二重に持つことになり、片方だけ直して食い違う。
 *
 * だから **package.json をそのまま読む**。書き写さないので、ずれない。
 */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** package.json の scripts から、その仕事の中身を取る。 */
export async function lookup(name, srcRoot = root) {
  const pkg = JSON.parse(await readFile(join(srcRoot, 'package.json'), 'utf8'));
  return pkg.scripts?.[name];
}

/**
 * `node ...` で始まる仕事だけを、この場で動かす。
 *
 * 殻に渡さない。渡すと、書いてある文字列がそのまま命令として実行され、
 * package.json を書き換えられる筋がそのまま実行の筋になる。
 * ここは起動の入口なので、**素直に動かすより、狭く動かす**。
 */
export function toCommand(script) {
  if (typeof script !== 'string') return undefined;
  const m = /^node\s+(.+)$/.exec(script.trim());
  if (!m) return undefined;
  // 引用符は使っていない前提で分ける。使い始めたらここで弾かれる（黙って壊れない）。
  const args = m[1].split(/\s+/).filter((a) => a.length > 0);
  return args.some((a) => /[&|;<>`$()]/.test(a)) ? undefined : args;
}

// Windows では `file://` + argv[1] にすると一致しない。
// argv[1] は Z:\...\run.mjs（円記号・ドライブ文字）、import.meta.url は
// file:///Z:/.../run.mjs。**一致しないので、中身が丸ごと動かない。**
// 何も言わずに終了コード0で終わるので、気づけない（実機でそうなった）。
// 実体の道どうしで比べる（`is-main.mjs`）。リンク越しに起こすと、何もせずに 0 で終わっていた
if (isMain(import.meta.url)) {
  const [name, ...rest] = process.argv.slice(2);
  if (!name) {
    console.error('使い方: node scripts/run.mjs <仕事の名前>');
    process.exit(2);
  }
  const script = await lookup(name);
  if (script === undefined) {
    console.error(`そういう仕事はありません: ${name}`);
    console.error('package.json の scripts に載っているものだけが動きます。');
    process.exit(2);
  }
  const args = toCommand(script);
  if (!args) {
    console.error(`この仕事は npm 無しでは動かせません: ${name}`);
    console.error(`  中身: ${script}`);
    console.error('（node で始まる仕事だけを、この入口から動かせます）');
    process.exit(2);
  }
  const child = spawn(process.execPath, [...args, ...rest], { stdio: 'inherit', cwd: root });
  forwardSignals(child, process);
  child.on('exit', (code) => process.exit(code ?? 1));
}

/**
 * 止める合図を、子へ渡す。
 *
 * ここは入口で、本体は子。合図（Ctrl-C や kill）はこの入口に来て、
 * **入口だけが死に、本体が親無しで生き続けていた**（check:bundle で
 * 画面を止めたつもりが、画面は答え続け、確かめ自体が終わらなかった）。
 * 合図を子へ渡して、子が終わるのを待つ。
 */
export function forwardSignals(child, proc) {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    proc.on(sig, () => { child.kill(sig); });
  }
}
