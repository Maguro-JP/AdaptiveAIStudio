/**
 * pre-push から呼ぶ入口。範囲を受け取って、止める理由があれば 1 で終わる。
 *
 * 判断そのものは docs-only-push.mjs に置いてある（押せる形にするため。
 * ここに書くと、シェル越しでしか確かめられない）。
 */
import { execFileSync } from 'node:child_process';
import { docsOnlyPush } from './docs-only-push.mjs';

const range = process.argv[2];
if (!range) process.exit(0);

let files = [];
let message = '';
try {
  files = execFileSync('git', ['diff', '--name-only', range], { encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
  message = execFileSync('git', ['log', '-1', '--format=%B', range.split('..')[1] ?? 'HEAD'], { encoding: 'utf8' });
} catch {
  // 範囲が読めないなら、止めない。止める側が勝手に止まるのがいちばん困る。
  process.exit(0);
}

const why = docsOnlyPush({ files, message });
if (!why) process.exit(0);
process.stdout.write(`== ${why}\n`);
process.exit(1);
