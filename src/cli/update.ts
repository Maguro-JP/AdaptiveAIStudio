/**
 * aas update — 新しくする。
 *
 * 押す前に中身を見せる。何が入るのか分からないまま新しくするのは、
 * 動いているものを賭けに出すのと同じ。
 */
import { resolve } from 'node:path';
import { checkUpdate, applyUpdate, describeUpdate } from '../core/update.ts';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const root = resolve(process.argv[2] ?? process.cwd());
console.log(c.cyan('AdaptiveAIStudio') + c.dim(' — 更新'));

const status = await checkUpdate(root);
console.log(`\n${describeUpdate(status)}\n`);

if (!status.can) process.exit(status.behind === 0 ? 0 : 1);

// 対話できない場所（ダブルクリック以外、他の道具から呼ばれた等）では、
// 黙って取り込まない。確認できないなら、確認できないと言って止まる。
if (!process.stdin.isTTY) {
  console.log(c.yellow('  取り込むには、対話できる場所で実行してください。\n'));
  process.exit(1);
}

const { createInterface } = await import('node:readline/promises');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('  取り込みますか？ [y/N]: ')).trim().toLowerCase();
rl.close();

if (answer !== 'y' && answer !== 'yes') {
  console.log(c.dim('\n  やめました。\n'));
  process.exit(0);
}

const result = await applyUpdate(root);
console.log(result.ok ? c.green(`\n  ${result.message}\n`) : c.yellow(`\n  ${result.message}\n`));
process.exit(result.ok ? 0 : 1);
