/**
 * pre-push から呼ぶ入口。確かめの前と後で木を読んで、ずれていたら 1 で終わる。
 *
 * 判断そのものは pushed-tree.mjs に置いてある（押せる形にするため。
 * ここに書くと、シェル越しでしか確かめられない）。
 *
 * 呼び方は二つ。
 *
 *   before <sending>            確かめの前。通れば、いまの木を一行で出す
 *   after  <sending> <before>   確かめの後。前の木と突き合わせる
 *
 * `before` を確かめの前に置くのは、**10 分待たせてから「汚れています」と
 * 言わないため。**動いたかどうかは後でしか分からないので、そこだけ後に回す。
 */
import { pushedTree } from './pushed-tree.mjs';
import { lookTree, pack, unpack } from './git-tree.mjs';

const look = () => lookTree();

function stop(why) {
  process.stdout.write(`== ${why}\n`);
  process.exit(1);
}

const mode = process.argv[2];
const sending = process.argv[3] ?? '';
try {
  if (mode === 'before') {
    const tree = look();
    // 前だけで分かることを、前に言う。動いたかどうかは after で見る。
    const why = pushedTree({ sending, before: tree, after: tree });
    if (why) stop(why);
    process.stdout.write(pack(tree));
    process.exit(0);
  }
  if (mode !== 'after') process.exit(0);

  const before = unpack(process.argv[4] ?? '');
  // 前の木が読めていないなら、比べようがない。止めない。
  if (!before.head) process.exit(0);
  const why = pushedTree({ sending, before, after: look() });
  if (why) stop(why);
  process.exit(0);
} catch {
  // git が読めないなら止めない。止める側が勝手に止まるのがいちばん困る。
  process.exit(0);
}
