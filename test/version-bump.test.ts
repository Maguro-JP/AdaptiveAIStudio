/**
 * 直したのに、版が据え置きのまま配らない。
 *
 * 版の付け方を決めていなかったので、`0.1.0 → 0.2.0 → 0.3.0` と**まん中だけ**
 * が上がり、最後の桁を一度も使っていなかった。しかも直した日に版を上げず、
 * `package.json` は 0.3.0 のまま 94 コミット進んでいた。
 *
 * **版が見えないまま検証すると、古いものを新しいと思って確かめてしまう。**
 * `doctor` の一行目に版を出しているのは、そのためだった。出す版そのものが
 * 据え置きでは、意味が無い。
 *
 *   直したら最後の桁。できることが増えたらまん中。
 *
 * ここで見るのは「タグより先へ進んでいるのに、版がタグのままではないか」だけ。
 * どの桁を上げるかは、人が決める（機械には、直しか機能かの区別が付かない）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// git のクローンでしか確かめられない。配ったものの中では飛ばす。
const sourceOnly = existsSync(join(root, '.git'))
  ? {}
  : { skip: '作業場にしか無いものを見る試験です（bundle では確かめられません）' };

describe('版を据え置きで配らない', () => {
  test('タグより先へ進んでいるなら、版も進んでいる', sourceOnly, () => {
    let described = '';
    try {
      described = execFileSync('git', ['describe', '--tags', '--long'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return; // タグがまだ一つも無いリポジトリでは、見るものが無い。
    }
    // v0.3.0-94-gfabaf91 → タグ v0.3.0 / そこから 94 コミット
    const m = /^(.+)-(\d+)-g[0-9a-f]+$/.exec(described);
    if (!m) return;
    const tag = m[1]!.replace(/^v/, '');
    const ahead = Number(m[2]);
    if (ahead === 0) return; // タグそのもの。版は一致していてよい。

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    assert.notEqual(
      pkg.version, tag,
      `タグ v${tag} から ${ahead} コミット進んでいるのに、package.json が ${pkg.version} のままです。`
      + '直しただけなら最後の桁、できることが増えたならまん中を上げてください。',
    );
  });
});
