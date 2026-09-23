/**
 * 画像は、在って・指されて・読めること。
 *
 * README の一番上に画面の例を置いた。**置いたものは、いつか道が変わる。**
 * 変わっても気づけないと、README に壊れた画像の枠だけが残る（初めて見る人が
 * 最初に見る所なので、そこが壊れているのがいちばん困る）。
 *
 * 見るのは三つ。指した先が在ること、代わりの文（alt）が書いてあること、
 * 置いたのに誰も指していない画像が無いこと。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES = 'docs/images';

/** その文書が指している画像を、書いてある順に拾う。 */
function refs(text: string): Array<{ alt: string; path: string }> {
  const out: Array<{ alt: string; path: string }> = [];
  for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    out.push({ alt: m[1] ?? '', path: m[2] ?? '' });
  }
  return out;
}

async function docs(): Promise<string[]> {
  const out = ['README.md'];
  for (const name of await readdir(join(root, 'docs'))) {
    if (name.endsWith('.md')) out.push(join('docs', name));
  }
  return out;
}

describe('文書が指している画像', () => {
  test('**指した先が在る**', async () => {
    const missing: string[] = [];
    for (const doc of await docs()) {
      const text = await readFile(join(root, doc), 'utf8');
      for (const r of refs(text)) {
        if (/^https?:/.test(r.path)) continue;
        // 相対の道は、その文書の在る所から辿る。
        const at = join(root, dirname(doc), r.path);
        const got = await stat(at).catch(() => undefined);
        if (!got?.isFile()) missing.push(`${doc} → ${r.path}`);
      }
    }
    assert.deepEqual(missing, [], `指した先が無い画像:\n  ${missing.join('\n  ')}`);
  });

  test('**代わりの文（alt）が書いてある**', async () => {
    // 表示できない所と、読み上げで使う。空にすると、そこに何が在るのか分からない。
    const bare: string[] = [];
    for (const doc of await docs()) {
      const text = await readFile(join(root, doc), 'utf8');
      for (const r of refs(text)) {
        if (r.alt.trim().length < 4) bare.push(`${doc} → ${r.path}`);
      }
    }
    assert.deepEqual(bare, [], `代わりの文が無い画像:\n  ${bare.join('\n  ')}`);
  });

  test('置いたのに、誰も指していない画像を残さない（対）', async () => {
    const here = await readdir(join(root, IMAGES)).catch(() => [] as string[]);
    if (here.length === 0) return;
    const all = (await Promise.all((await docs()).map((d) => readFile(join(root, d), 'utf8')))).join('\n');
    const orphans = here.filter((name) => !all.includes(`${IMAGES}/${name}`));
    assert.deepEqual(orphans, [], `誰も指していない画像:\n  ${orphans.join('\n  ')}`);
  });
});
