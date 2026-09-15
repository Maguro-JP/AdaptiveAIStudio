/**
 * 打ち込みのコマンドと、作業場の skill。
 *
 * `/fix` と打ったら指示に置き換わること、作業場の SKILL.md が拾われること、
 * 知らない名前はそのまま送らないこと。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import {
  BUILTIN_COMMANDS, expandCommand, listCommands, parseSkill, splitCommand, fill,
} from '../src/agent/commands.ts';

describe('打ったものを分ける', () => {
  test('/名前 と後ろの文', () => {
    assert.deepEqual(splitCommand('/fix  ログインが落ちる'), { name: 'fix', args: 'ログインが落ちる' });
    assert.deepEqual(splitCommand('/fix'), { name: 'fix', args: '' });
    assert.deepEqual(splitCommand('/fix\n二行目'), { name: 'fix', args: '二行目' });
  });
  test('コマンドでないものは触らない', () => {
    assert.equal(splitCommand('ふつうの文'), undefined);
    assert.equal(splitCommand('/ 空白から'), undefined);
    assert.equal(splitCommand('a/b は道'), undefined);
  });
});

describe('組み込み', () => {
  test('$ARGUMENTS の所へ後ろの文が入る', () => {
    const fix = BUILTIN_COMMANDS.find((c) => c.name === 'fix')!;
    const out = fill(fix, 'ログインが落ちる');
    assert.ok(out.includes('ログインが落ちる'));
    assert.ok(!out.includes('$ARGUMENTS'));
    assert.ok(out.startsWith('次の不具合を直してください'));
  });
  test('名前は ASCII だけ', () => {
    for (const c of BUILTIN_COMMANDS) assert.match(c.name, /^[a-z]+$/, c.name);
  });
});

describe('作業場の skill', () => {
  test('.claude/skills/<name>/SKILL.md を拾い、頭の name/description を読む', async () => {
    const root = await tempDir('aas-skill-');
    await mkdir(join(root, '.claude', 'skills', 'deploy'), { recursive: true });
    await writeFile(join(root, '.claude', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: 配る手順\n---\n\n配る前に必ずテストを通す。\n\n$ARGUMENTS\n');
    const all = await listCommands(root);
    const deploy = all.find((c) => c.name === 'deploy');
    assert.ok(deploy, '拾えていない');
    assert.equal(deploy.description, '配る手順');
    assert.equal(deploy.source, 'skill');
    assert.equal(deploy.path, join('.claude/skills', 'deploy', 'SKILL.md'));
    const x = await expandCommand('/deploy 本番へ', root);
    assert.equal(x.kind, 'command');
    if (x.kind === 'command') assert.equal(x.text, '配る前に必ずテストを通す。\n\n本番へ');
  });

  test('頭が無ければ、フォルダ名と最初の一行', () => {
    const s = parseSkill('# 片づけ\n\n古いものを消す。', 'tidy');
    assert.equal(s.name, 'tidy');
    assert.equal(s.description, '片づけ');
    assert.equal(s.body, '# 片づけ\n\n古いものを消す。');
  });

  test('同じ名前なら作業場の skill が勝つ', async () => {
    const root = await tempDir('aas-skill-');
    await mkdir(join(root, '.agents', 'skills', 'fix'), { recursive: true });
    await writeFile(join(root, '.agents', 'skills', 'fix', 'SKILL.md'), 'うちの直し方。');
    const all = await listCommands(root);
    assert.equal(all.filter((c) => c.name === 'fix').length, 1);
    assert.equal(all.find((c) => c.name === 'fix')!.source, 'skill');
  });

  test('作業場に skill が無くても、組み込みは在る', async () => {
    const root = await tempDir('aas-skill-');
    const all = await listCommands(root);
    assert.deepEqual(all.map((c) => c.name), BUILTIN_COMMANDS.map((c) => c.name));
  });
});

describe('知らない名前', () => {
  test('そのまま送らず、知っている名前を返す', async () => {
    const root = await tempDir('aas-skill-');
    const x = await expandCommand('/fxi これ', root);
    assert.equal(x.kind, 'unknown');
    if (x.kind === 'unknown') { assert.equal(x.name, 'fxi'); assert.ok(x.known.includes('fix')); }
  });
  test('コマンドでない文は、そのまま（対）', async () => {
    const x = await expandCommand('ふつうの文', await tempDir('aas-skill-'));
    assert.deepEqual(x, { kind: 'plain', text: 'ふつうの文' });
  });
});
