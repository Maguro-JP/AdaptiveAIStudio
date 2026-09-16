/**
 * aas clean — 溜まったものを片づける。
 *
 * 既定では**見せるだけ**。消すのは --yes を付けたときだけ。
 * 消える物を見ないまま消させると、次に何かが無くなったときに
 * この道具を疑うことになる。
 */
import { findRemovable, remove, describe, mb } from '../runtime/cleanup.ts';
import { PINNED_TAG } from '../runtime/llama-release.ts';
import { c } from './colors.ts';
import { how } from './how.ts';

const items = await findRemovable({ keepTag: PINNED_TAG });

console.log(c.cyan('AdaptiveAIStudio') + c.dim(' — clean\n'));
console.log(describe(items));

if (items.length === 0) process.exit(0);

if (!process.argv.includes('--yes')) {
  console.log('');
  // **打てる形で言う。**配った形に npm は無いので、入口の呼び方で出す。
  console.log(c.dim(`  消すときは --yes を付けてください:  ${how('clean', '--yes')}`));
  process.exit(0);
}

console.log('');
const { freed, failed } = await remove(items);
console.log(c.green(`  ${mb(freed)} 空けました`));
for (const f of failed) {
  console.log(c.yellow(`  消せませんでした（使用中かもしれません）: ${f}`));
}
