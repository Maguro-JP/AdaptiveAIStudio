/**
 * 何も入っていない機械で用意する `installer/bootstrap.cmd` の不具合（44 回目の調査）。
 *
 * - bootstrap で入れた版が、いつ入れても「main-bootstrap」で、package の版も取った commit も分からなかった
 * - 試験が落ちたときに、入口に無い番号（6 番）を案内していた
 * - 二度ダブルクリックすると、後の回が先の回の作業フォルダを途中で消していた
 *
 * Z: で .exe を受け取らない件は `test/home.test.ts` の「用意用が置く場所と、入口が探す場所が同じ」で見る。
 * cmd.exe はここでは動かせないので、Windows の実機での動きは確かめていない（書いた形を見ている）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { installRoot } from '../src/core/home.ts';
// @ts-expect-error 型定義を置かない開発用の script。ここだけ読む。
import { stampedVersion } from '../scripts/bundle.mjs';

const sourceOnly = existsSync(join(installRoot(), 'installer'))
  ? {}
  : { skip: '作業場にしか無いものを見る試験です（bundle では確かめられません）' };
const cmd = (bytes: Uint8Array): string => new TextDecoder('shift_jis').decode(bytes);
const read = async (...p: string[]): Promise<string> => cmd(await readFile(join(installRoot(), ...p)));

describe('版', () => {
  test('**+ で始まる版は、package.json の版に足す**', async () => {
    const dir = await tempDir('aas-bootstrap-version-');
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    assert.equal(stampedVersion('+abc1234-bootstrap', dir), '9.9.9+abc1234-bootstrap');
    assert.equal(stampedVersion('here', dir), 'here', '渡した版をそのまま使わない');
    assert.equal(stampedVersion(undefined, dir), '9.9.9');
  });

  test('**bootstrap は package の版を消さない形で版を渡す**', sourceOnly, async () => {
    const boot = await read('installer', 'bootstrap.cmd');
    const given = [...boot.matchAll(/--version "([^"]*)"/g)].map((m) => m[1]!);
    assert.deepEqual(given, ['%STAMP%']);
    const stamps = [...boot.matchAll(/set "STAMP=([^"]*)"/g)].map((m) => m[1]!);
    assert.ok(stamps.length >= 2, `取った commit を載せる形が無い: ${stamps.join(', ')}`);
    for (const s of stamps) assert.ok(s.startsWith('+'), `package の版を消す: ${s}`);
    assert.ok(stamps.some((s) => s.includes('%SHA:~0,7%')), '取った commit を版に載せていない');
  });
});

describe('案内', () => {
  test('**bootstrap が案内する入口の番号は、どれも入口のメニューに在る**', sourceOnly, async () => {
    const boot = await read('installer', 'bootstrap.cmd');
    const start = await read('start.cmd');
    const said = [...boot.matchAll(/入口の\s*([0-9]+)\s*番/g)].map((m) => m[1]!);
    assert.ok(said.length > 0, '前提: 番号を案内している');
    for (const n of said) assert.ok(start.includes(`"%CHOICE%"=="${n}"`), `入口に ${n} 番が無い`);
  });
});

describe('二重に起こしたとき', () => {
  test('**錠のフォルダを mkdir で取り、取れなければ作業フォルダに触らずに止まる**', sourceOnly, async () => {
    const boot = await read('installer', 'bootstrap.cmd');
    const take = boot.indexOf('mkdir "%LOCK%"');
    assert.ok(take > 0, '錠を取っていない');
    assert.ok(take < boot.indexOf('rmdir /s /q "%WORK%"'), '錠を取る前に作業フォルダを消している');
    assert.match(boot.slice(take, take + 120), /if errorlevel 1 goto :busy/);
    const at = boot.indexOf('\n:busy');
    assert.ok(at > 0, ':busy が無い');
    const busy = boot.slice(at, boot.indexOf('exit /b 1', at));
    assert.doesNotMatch(busy, /rmdir/, '取れなかった回が、ほかの回の錠や作業フォルダを消す');
  });

  test('**錠を取った後の終わり方は、どれも錠を返す**', sourceOnly, async () => {
    const boot = await read('installer', 'bootstrap.cmd');
    // 錠を取った後の流れ（文だけを置く欄の手前まで）から飛ぶ先
    const body = boot.slice(boot.indexOf('mkdir "%LOCK%"'), boot.indexOf('rem  Messages only'));
    assert.ok(body.length > 0, '前提: 流れと文の欄の境が見つからない');
    const targets = new Set([...body.matchAll(/goto :([A-Za-z]+)/g)].map((m) => m[1]!));
    targets.delete('busy');
    const blockOf = (label: string): string => {
      const at = boot.indexOf(`\n:${label}`);
      assert.ok(at >= 0, `飛び先 ${label} が無い`);
      const next = boot.indexOf('\n:', at + 2);
      return boot.slice(at, next < 0 ? undefined : next);
    };
    for (const label of targets) {
      // 飛び先を順にたどって、exit までに錠を返すか
      let at = label;
      let released = false;
      for (let hops = 0; hops < 10; hops++) {
        const block = blockOf(at);
        if (/rmdir "%LOCK%"/.test(block)) { released = true; break; }
        const exit = /exit \/b/.test(block);
        const jump = /goto :([A-Za-z]+)/.exec(block);
        if (exit || !jump) {
          // 落ちて次のラベルへ流れる形（goto も exit も無い）
          if (!exit && !jump) { const after = boot.indexOf('\n:', boot.indexOf(`\n:${at}`) + 2); at = /\n:([A-Za-z]+)/.exec(boot.slice(after))![1]!; continue; }
          break;
        }
        at = jump[1]!;
      }
      assert.ok(released, `${label} から錠を返さずに終わる`);
    }
  });
});
