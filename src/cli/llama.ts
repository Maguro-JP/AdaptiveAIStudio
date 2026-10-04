/**
 * aas llama — llama-server を自前で用意する。
 *
 * これまで実体は「PATH にある誰かが入れたもの」だった。
 * それを消されたら動かない作りをやめ、この道具が自分で持つ。
 */
import { detectMachine } from '../runtime/machine.ts';
import { install, findInstalled, listInstalled, defaultBinDir, tryRun } from '../runtime/llama-install.ts';
import { PINNED_TAG } from '../runtime/llama-release.ts';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

console.log(c.cyan('AdaptiveAIStudio') + c.dim(' — llama-server の用意'));

const binDir = defaultBinDir();
const machine = await detectMachine();
const hasNvidia = /nvidia|geforce|rtx|quadro|tesla/i.test(machine.gpuName ?? '');

console.log(c.dim(`  置き場: ${binDir}`));
console.log(c.dim(`  この機械: ${machine.gpuName ?? 'GPUなし'} / ${process.platform}-${process.arch}`));

const force = process.argv.includes('--force');
const already = await findInstalled(binDir);
// 在るだけでは「用意できています」と言わない。一度起こして版を言えるか見る（途中で切れた半端な版を、動くと言わない）
const broken = already && !force ? await tryRun(already) : undefined;
if (broken && !broken.ok) {
  console.log(c.yellow(`\n  在りますが、動きません: ${already}\n  ${broken.detail.split('\n')[0]}\n  取り直します。`));
}
if (already && !force && broken?.ok) {
  console.log(c.green(`\n  用意できています: ${already}\n`));
  const versions = await listInstalled(binDir);
  if (versions.length > 1) console.log(c.dim(`  置いてある版: ${versions.join(', ')}\n`));
  process.exit(0);
}

console.log(c.dim(`\n  取ってくる版: ${PINNED_TAG}`));
console.log(c.dim('  取得元: github.com/ggml-org/llama.cpp のリリース\n'));

try {
  const r = await install({
    binDir,
    // 在るのに動かないとき・`--force` のときは、同じ版でも取り直す（動く版は、新しい版が動くと確かめてから入れ替える）
    force: force || (broken !== undefined && !broken.ok),
    target: { platform: process.platform, arch: process.arch, hasNvidia },
    onProgress: (line) => console.log(c.dim(`  ${line}`)),
  });
  console.log(c.green(`\n  用意できました: ${r.command}`));
  console.log(c.dim(`  ${r.asset}（${r.why}）\n`));
  console.log(c.dim('  設定は要りません。runtime.kind を llamacpp にすれば、これが使われます。\n'));
} catch (e) {
  console.log(c.red(`\n  用意できませんでした: ${e instanceof Error ? e.message : String(e)}\n`));
  process.exit(1);
}
