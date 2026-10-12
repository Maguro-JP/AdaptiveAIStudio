/**
 * 83 回目の不具合調査（ツール呼び出しの手前で止める規則のすり抜け）の分。
 *
 * - `git config -f <ファイル>` の値を鍵と読まない
 * - push・作業ツリーを戻すのと同じことをする別のサブコマンドも止める
 * - 外へ出す検問: PGP の秘密鍵・Windows の殻の書き方・Google と Hugging Face の鍵
 * - 外のツールの、空白を含む作業場の外の絶対の道も、守りで見る
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { gitDanger, protectedPaths } from '../src/harness/builtin-rules.ts';
import { inspectOutbound } from '../src/harness/gate.ts';

describe('git の危ない形', () => {
  test('**`git config -f <ファイル>` でも、命令を走らせる設定の書き換えとして止める**', () => {
    for (const c of ['git config -f .git/config alias.p push', 'git config --file .git/config core.hooksPath hooks', 'git config set --file x alias.p push']) {
      assert.ok(gitDanger(c), `通した: ${c}`);
    }
  });

  test('ファイルを指して読むだけなら止めない（対）', () => {
    assert.equal(gitDanger('git config -f .git/config --get alias.p'), undefined);
    assert.equal(gitDanger('git config -f .git/config user.name x'), undefined);
  });

  test('**push と同じことをする別のサブコマンドも止める**', () => {
    for (const c of ['git subtree push --prefix=dist origin gh-pages', 'git send-pack origin main']) {
      assert.equal(gitDanger(c), 'push', `通した: ${c}`);
    }
  });

  test('**作業ツリーを戻す別のサブコマンドも止める**', () => {
    for (const c of ['git checkout-index -a -f', 'git read-tree --reset -u HEAD']) {
      assert.ok(gitDanger(c), `通した: ${c}`);
    }
    // 索引だけを読むものは止めない（対）
    assert.equal(gitDanger('git read-tree HEAD'), undefined);
    assert.equal(gitDanger('git checkout-index -a'), undefined);
  });
});

describe('外へ出す検問', () => {
  test('**PGP の秘密鍵・Windows の殻の書き方・Google と Hugging Face の鍵を止める**', () => {
    const samples = [
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc',
      'set AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
      '$env:OPENAI_API_KEY="abcdefghijklmnopqrstuvwxyz123456"',
      'setx GITHUB_TOKEN abcdefghijklmnopqrstuvwxyz',
      `key=AIza${'B'.repeat(35)}`,
      `token hf_${'a'.repeat(30)}`,
    ];
    for (const s of samples) assert.equal(inspectOutbound(s).passed, false, `素通りした: ${s}`);
  });

  test('鍵の話をするだけの文は止めない（対）', () => {
    assert.equal(inspectOutbound('set the GITHUB_TOKEN in your CI settings').passed, true);
  });
});

describe('外のツールの道', () => {
  test('**空白を含む、作業場の外の絶対の道も守りで見る**', async () => {
    const root = await tempDir('aas-guard-root-');
    const outside = await tempDir('aas-guard-out-');
    await mkdir(join(outside, 'My Docs'), { recursive: true });
    const rule = protectedPaths(['**/.env']);
    const d = await rule.pre!(
      { id: 'w', name: 'fs__write_file', args: { path: join(outside, 'My Docs', '.env') } },
      { root, history: [], instruction: '', signal: new AbortController().signal },
    );
    assert.equal(d.kind, 'deny', `空白を含む外の絶対の道を素通しした: ${JSON.stringify(d)}`);
  });
});

describe('命令を通した書き込み（DECISIONS 10-11、117 回目）', () => {
  const ask = async (command: string) => {
    const root = await tempDir('aas-guard-cmd-');
    const rule = protectedPaths(['**/.env', '**/.git/**', '**/*.key']);
    return (await rule.pre!({ id: 'c', name: 'run_command', args: { command } },
      { root, history: [], instruction: '', signal: new AbortController().signal })).kind;
  };
  test('守っているファイルへの書き込みは、命令を通しても止める', async () => {
    for (const command of [
      'echo x > .env', 'echo x >> sub/.env', 'printf a 2> .env', 'cat a | tee .git/config', 'tee -a .env < a',
      'cp /tmp/h .git/hooks/pre-commit', 'mv x server.key', "sed -i 's/a/b/' .env", 'dd if=a of=.env', 'echo x >".env"',
      // 118 回目: `-t`・フォルダへ写す形・`>|`・動かす/消す元・PowerShell の書き込み
      'cp -t .git/hooks x', 'cp x .git/', 'cp -r x .git', 'install -t .git/hooks x', 'echo a >| .env',
      'mv .env y', 'rm .env', 'Set-Content .env x', 'Set-Content -Path .env -Value x', 'echo x | Out-File -FilePath .env',
    ]) assert.equal(await ask(command), 'deny', `通ってしまった: ${command}`);
  });
  test('守っていないファイルへの書き込みと、読むだけの命令は止めない（対）', async () => {
    for (const command of [
      'echo x > out.txt', 'cat .env', 'cp .env backup.txt', 'npm test 2>&1', 'git status', 'echo x >&2',
      'echo "a > .env"', "echo 'x | tee .env'", 'echo ">" a.env-notes', 'cp a src/', 'mv a b', 'rm out.txt',
    ]) {
      assert.equal(await ask(command), 'allow', `止めてしまった: ${command}`);
    }
  });
});
