/**
 * 公開して困るものを、リポジトリに入れさせない。
 *
 * このリポジトリは公開する前提で書く。判定の一覧は `docs/PUBLISHING.md`。
 * そのうち機械で判定できるものを、ここで止める。
 *
 * - メールアドレスは、ダミーのドメイン（example.com など）だけ
 * - `Maguro-JP/<名前>` で指すのは、このリポジトリだけ（公開していない別のリポジトリの名前を出さない）
 *
 * `.claude/` の中は別のリポジトリから配られてくるので、ここでは見ない（配る元で直す）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// git の管理下の一覧を使う。bundle の中（.git が無い）では見るものが無い。
const noGit = !existsSync(join(root, '.git'));

function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return out.split('\0').filter((f) => f && !f.startsWith('.claude/') && f !== 'test/publishing.test.ts')
    .filter((f) => /\.(ts|mts|mjs|js|json|md|txt|cmd|sh|nsi|yml|yaml|html|css)$/i.test(f) || !f.includes('.'));
}

/** ダミーとして使ってよいドメイン。 */
const DUMMY_DOMAIN = /(^|\.)(example\.(com|net|org)|example|invalid|test|localhost|internal)$|^anthropic\.com$|^users\.noreply\.github\.com$/i;

export function emailsIn(text: string): string[] {
  const found: string[] = [];
  // 全角で書いたものも半角に揃えてから探す（全角の利用者名・アドレスを見落としていた）
  for (const m of text.normalize('NFKC').matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g)) {
    if (!DUMMY_DOMAIN.test(m[1] ?? '')) found.push(m[0]);
  }
  return found;
}

export function otherReposIn(text: string): string[] {
  return [...text.matchAll(/Maguro-JP\/([A-Za-z0-9_.-]+)/g)]
    .map((m) => (m[1] ?? '').replace(/\.git$/, ''))
    .filter((name) => name !== 'AdaptiveAIStudio');
}

test('判定そのもの: ダミーは通し、本物らしいアドレスと別のリポジトリは拾う', () => {
  assert.deepEqual(emailsIn('user@example.com と t@x.invalid と noreply@anthropic.com'), []);
  assert.deepEqual(emailsIn('連絡は someone@mail.co.jp まで'), ['someone@mail.co.jp']);
  assert.deepEqual(emailsIn('全角で ｓｏｍｅｏｎｅ＠ｍａｉｌ．ｃｏ．ｊｐ'), ['someone@mail.co.jp']);
  assert.deepEqual(otherReposIn('github.com/Maguro-JP/AdaptiveAIStudio'), []);
  assert.deepEqual(otherReposIn('Maguro-JP/Other.git を見る'), ['Other']);
});

test('管理下のファイルに、本物らしいメールアドレスが無い', { skip: noGit }, () => {
  const hits: string[] = [];
  for (const f of trackedTextFiles()) {
    for (const e of emailsIn(readFileSync(join(root, f), 'utf8'))) hits.push(`${f}: ${e}`);
  }
  assert.deepEqual(hits, [], 'ダミー（user@example.com など）に置き換える');
});

test('管理下のファイルが、このリポジトリ以外の Maguro-JP のリポジトリを名指ししない', { skip: noGit }, () => {
  const hits: string[] = [];
  for (const f of trackedTextFiles()) {
    for (const r of otherReposIn(readFileSync(join(root, f), 'utf8'))) hits.push(`${f}: ${r}`);
  }
  assert.deepEqual(hits, [], '「別のリポジトリ」のように一般化する');
});

/** 人の反応を書き留めた形。文書（*.md）でだけ見る（製品の機能の語と重なるため、コードは見ない）。 */
const REACTION = /怒られ|言い直させ|理不尽|言い聞かせ/;

test('文書に、人の反応を書き留めた言い方が無い', { skip: noGit }, () => {
  const out = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: root, encoding: 'utf8' });
  const hits: string[] = [];
  for (const f of out.split('\0').filter(Boolean)) {
    readFileSync(join(root, f), 'utf8').split('\n').forEach((line, i) => {
      if (REACTION.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 60)}`);
    });
  }
  assert.deepEqual(hits, [], '自分がやったことと、その結果だけで書く（docs/PUBLISHING.md）');
});

test('コードとコメントにも、人の反応を書き留めた言い方が無い', { skip: noGit }, () => {
  const hits: string[] = [];
  for (const f of trackedTextFiles()) {
    readFileSync(join(root, f), 'utf8').split('\n').forEach((line, i) => {
      if (/怒られ|理不尽/.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
