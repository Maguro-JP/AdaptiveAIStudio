/**
 * いま何を触っているかを、画面に出す。
 *
 * 動いている間、画面には「作業中」と経過だけが出ていた。**何をしているかは
 * 出ない。**3 分黙っているとき、読んでいるのか、走らせているのか、外へ
 * 出ているのかが分からない。分からないと、止めていいのかも決められない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doingText, TOOL_VERB } from '../src/ui/web/doing.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('いま何を触っているか', () => {
  test('知っている名前は、日本語で出す', () => {
    assert.equal(doingText('read_file', 'src/a.ts'), '読んでいます src/a.ts');
    assert.equal(doingText('run_command', 'npm test'), '走らせています npm test');
  });

  test('**知らない名前も、隠さずに出す**', () => {
    // 訳が無いことを理由に隠すと、足したばかりのツールのときだけ
    // 何も出なくなる。いちばん見たいときに見えない。
    assert.equal(doingText('brand_new_tool', 'x'), 'brand_new_tool x');
    assert.ok(doingText('brand_new_tool').length > 0);
  });

  test('外の相手は、相手の名前で出す', () => {
    assert.match(doingText('github__create_issue', 'x'), /^github を呼んでいます/);
  });

  test('**足したツールが、訳の表から漏れていない**', () => {
    /*
     * 表に足し忘れると、そのツールのときだけ英語の名前が出る。
     * 落ちないテストは無いのと同じなので、こちらが配っているツールの
     * 名前を、実際に読み取って突き合わせる。
     */
    const names = new Set<string>();
    for (const dir of ['src/agent/tools']) {
      for (const f of readdirSync(join(root, dir))) {
        if (!f.endsWith('.ts')) continue;
        const text = readFileSync(join(root, dir, f), 'utf8');
        for (const m of text.matchAll(/^\s*name: '([a-z_]+)',$/gm)) names.add(m[1]!);
      }
    }
    assert.ok(names.size > 0, 'ツールの名前を読み取れていない（この確かめの前提が崩れている）');
    const missing = [...names].filter((n) => !(n in TOOL_VERB)).sort();
    assert.deepEqual(missing, [], `訳が無いツール: ${missing.join(', ')}`);
  });
});
