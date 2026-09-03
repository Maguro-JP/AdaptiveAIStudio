/**
 * 命令が呼べるかを、立ち上げる前に見る。
 *
 * 配布物には npm も npx も入っていない。設定には書けてしまうので、
 * 「書いたのに何も起きない」になる。ここで見分けられることを留める。
 *
 * **走らせる場所で結果を変えない。**PATH も、在るかどうかの見方も渡す。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findOnPath } from '../src/core/which.ts';

/**
 * 在ることにするものを決めて、見方を作る。
 *
 * 大小は区別しない。Windows のファイルシステムがそうなので、
 * PATHEXT の `.CMD` で探して `npx.cmd` が見つかる。ここで区別すると、
 * 本物では起きない外れ方を試験の中だけで作ることになる。
 */
const having = (...paths: string[]) => {
  const lower = paths.map((p) => p.toLowerCase());
  return (p: string) => lower.includes(p.toLowerCase());
};

describe('その命令が呼べるか', () => {
  test('Windows は PATHEXT を足して探す', () => {
    const found = findOnPath('npx', {
      platform: 'win32',
      path: 'C:\\Windows;C:\\Program Files\\nodejs',
      pathext: '.COM;.EXE;.BAT;.CMD',
      exists: having('C:\\Program Files\\nodejs\\npx.CMD'),
    });
    assert.equal(found, 'C:\\Program Files\\nodejs\\npx.CMD');
  });

  test('配布物のように node だけなら、npx は見つからない', () => {
    // ここが本題。node は同梱、npm と npx は入っていない。
    const env = {
      platform: 'win32' as const,
      path: 'Z:\\AdaptiveAIStudio\\runtime',
      pathext: '.COM;.EXE;.BAT;.CMD;.BIN',
      exists: having('Z:\\AdaptiveAIStudio\\runtime\\node.bin'),
    };
    // 返るのは探した名前（PATHEXT の大小がそのまま乗る）。大小は区別せずに見る。
    assert.equal(findOnPath('node', env)?.toLowerCase(),
      'z:\\adaptiveaistudio\\runtime\\node.bin', 'node は呼べるはず');
    assert.equal(findOnPath('npx', env), undefined, 'npx が呼べることになっている');
  });

  test('PATHEXT が無くても、既定の並びで探す', () => {
    const found = findOnPath('npx', {
      platform: 'win32',
      path: 'C:\\nodejs',
      exists: having('C:\\nodejs\\npx.CMD'),
    });
    assert.equal(found, 'C:\\nodejs\\npx.CMD');
  });

  test('拡張子が付いていれば、足さない', () => {
    const found = findOnPath('node.exe', {
      platform: 'win32',
      path: 'C:\\nodejs',
      pathext: '.EXE',
      exists: having('C:\\nodejs\\node.exe'),
    });
    assert.equal(found, 'C:\\nodejs\\node.exe');
    // node.exe.EXE を探しに行っていないこと（在ることにしても、そちらを返さない）
    const other = findOnPath('node.exe', {
      platform: 'win32',
      path: 'C:\\nodejs',
      pathext: '.EXE',
      exists: having('C:\\nodejs\\node.exe.EXE'),
    });
    assert.equal(other, undefined);
  });

  test('Unix は拡張子を足さない', () => {
    const env = {
      platform: 'linux' as const,
      path: '/usr/bin:/usr/local/bin',
      exists: having('/usr/local/bin/npx'),
    };
    assert.equal(findOnPath('npx', env), '/usr/local/bin/npx');
    assert.equal(findOnPath('npm', env), undefined);
  });

  test('道を含む名前は、PATH を見ない', () => {
    // 書いてある場所だけを見る。PATH に同じ名前があっても拾わない。
    const found = findOnPath('./tools/mcp-server', {
      platform: 'linux',
      path: '/usr/bin',
      exists: having('/usr/bin/mcp-server'),
    });
    assert.equal(found, undefined);
  });

  test('PATH が空でも落ちない', () => {
    assert.equal(findOnPath('npx', { platform: 'linux', exists: () => true }), undefined);
  });
});
