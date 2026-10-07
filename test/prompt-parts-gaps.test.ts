/**
 * 依頼に添えるものを組む所の不具合（49 回目の調査）。
 *
 * - 作業場の決まりのファイルがリンクで外を指していても、その先（鍵など）を読んでシステムプロンプトに載せていた。FIFO で止まっていた
 * - `@` の指名が、リンク越しに作業場の外を読み、FIFO で止まり、巨大なファイルを全部読んでいた
 * - ファイル名を挙げた問い・作業を頼む問いを雑談と読み、ツールを外して答えさせていた
 * - `CLAUDE.md -> AGENTS.md` のリンクで、同じ決まりを二度載せていた
 * - BOM 付きの `.gitignore` の 1 行目が効かなかった
 * - 判じ手が読めなかったときの合図の拾い方が、ふつうの依頼を「嫌がられたこと」と覚えていた
 * - 決まりの読み込み中に来た呼び出しが、空の決まりで組んでいた
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { readProjectRules, ProjectRules } from '../src/agent/project-rules.ts';
import { readMentions } from '../src/agent/mention.ts';
import { looksLikeChat } from '../src/core/intent.ts';
import { Ignores } from '../src/agent/ignore.ts';
import { senseDispleasure } from '../src/memory/displeasure.ts';

const KEY = 'ghp_' + 'A'.repeat(36);

async function place(): Promise<{ root: string; outside: string }> {
  const home = await tempDir('aas-prompt-parts-');
  const root = join(home, 'project');
  const outside = join(home, 'secret');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'id_rsa'), `-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETBODY\n-----END OPENSSH PRIVATE KEY-----\n`);
  return { root, outside };
}

describe('作業場の決まり', () => {
  test('**リンクで外を指す決まりのファイルは読まない**', async () => {
    const { root, outside } = await place();
    await symlink(join(outside, 'id_rsa'), join(root, 'AGENTS.md'));
    const rules = await readProjectRules(root);
    assert.equal(rules.some((r) => r.text.includes('SECRETBODY')), false, `外の鍵を決まりとして読んだ: ${JSON.stringify(rules)}`);
  });

  test('**FIFO の決まりのファイルで止まらない**', { skip: process.platform === 'win32' ? 'FIFO は Windows に無い' : false, timeout: 10_000 }, async () => {
    const { root } = await place();
    execFileSync('mkfifo', [join(root, 'CLAUDE.md')]);
    const rules = await readProjectRules(root);
    assert.ok(rules.find((r) => r.path === 'CLAUDE.md'), '読めなかったことを言っていない');
  });

  test('**同じ実体（リンク）の決まりは一度だけ載せる**', async () => {
    const { root } = await place();
    await writeFile(join(root, 'AGENTS.md'), '# 決まり\nテストを先に書く\n');
    await symlink('AGENTS.md', join(root, 'CLAUDE.md'));
    const rules = await readProjectRules(root);
    assert.equal(rules.filter((r) => r.text.includes('テストを先に書く')).length, 1, `二度載せた: ${rules.map((r) => r.path).join(',')}`);
  });

  test('**決まりに書かれた秘密は伏せる**', async () => {
    const { root } = await place();
    await writeFile(join(root, 'AGENTS.md'), `トークンは ${KEY} を使う\n`);
    const rules = await readProjectRules(root);
    assert.equal(rules.some((r) => r.text.includes(KEY)), false);
  });

  test('**読み込み中に来た呼び出しも、読み終えた決まりを受け取る**', async () => {
    const { root } = await place();
    await writeFile(join(root, 'AGENTS.md'), '# 決まり\nテストを先に書く\n');
    const rules = new ProjectRules(root);
    const [a, b] = await Promise.all([rules.all(1_000_000), rules.all(1_000_001)]);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1, '読み込み中の呼び出しに、空の決まりを返した');
  });
});

describe('@ の指名', () => {
  test('**リンク越しに作業場の外を読まない**', async () => {
    const { root, outside } = await place();
    await symlink(outside, join(root, 'home'));
    const reads = await readMentions('@home/id_rsa を見て', root);
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.ok, false, `外の鍵を読んだ: ${reads[0]!.body}`);
  });

  test('**FIFO を指名しても止まらない**', { skip: process.platform === 'win32' ? 'FIFO は Windows に無い' : false, timeout: 10_000 }, async () => {
    const { root } = await place();
    execFileSync('mkfifo', [join(root, 'pipe')]);
    const reads = await readMentions('@pipe を見て', root);
    assert.equal(reads[0]!.ok, false);
  });

  test('**大きなファイルは頭だけを読み、字の途中で切っても読み方を取り違えない**', async () => {
    const { root } = await place();
    // 字の境目が上限からずれる大きさ（3 バイトの字を並べる）
    await writeFile(join(root, 'big.md'), 'あ'.repeat(200_000));
    const reads = await readMentions('@big.md を見て', root, { maxBytes: 100, totalBytes: 100 });
    assert.equal(reads[0]!.ok, true, reads[0]!.body);
    assert.match(reads[0]!.body, /^あ+$/, `読み方を取り違えた: ${reads[0]!.body.slice(0, 40)}`);
  });
});

describe('雑談か作業か', () => {
  for (const text of ['README.md に何が書いてある？', 'package.json の version は？', 'README を更新して？', 'このバグ直せる？', 'Can you update the README?']) {
    test(`**${JSON.stringify(text)} を雑談と読まない**`, () => {
      assert.equal(looksLikeChat(text), false);
    });
  }
  for (const text of ['明日の天気は？', 'こんにちは', '1+1=', '円周率は3.14？']) {
    test(`${JSON.stringify(text)} は雑談のまま`, () => {
      assert.equal(looksLikeChat(text), true);
    });
  }
});

describe('.gitignore', () => {
  test('**BOM 付きでも 1 行目の規則が効く**', async () => {
    const { root } = await place();
    await writeFile(join(root, '.gitignore'), '\uFEFFnode_modules/\ndist/\n');
    const ig = await Ignores.load(root);
    assert.equal(ig.ignores('node_modules', true), true, '1 行目の規則が効いていない');
    assert.equal(ig.ignores('dist', true), true);
  });
});

describe('嫌がられたことの合図', () => {
  for (const text of ['この処理は複雑なので分けて', '雑談モードを足して', 'いつもの手順でビルドして', '毎回テストを走らせて', 'このログは要らないので消して', '違うファイルを開いて', '通るようになっていないか確認して']) {
    test(`**${JSON.stringify(text)} は、嫌がられたことと覚えない**`, () => {
      assert.equal(senseDispleasure(text), undefined);
    });
  }
  for (const text of ['雑な仕事', 'それ違う', 'いつも同じ間違いをする', '動いてない', '余計なことはしないで']) {
    test(`${JSON.stringify(text)} は拾う`, () => {
      assert.notEqual(senseDispleasure(text), undefined);
    });
  }
});
