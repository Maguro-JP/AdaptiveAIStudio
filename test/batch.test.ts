/**
 * バッチファイルの決めごと。
 *
 * cmd.exe は括弧の塊を**まとめて**解釈する。そこに多バイト文字が入ると
 * 行が壊れ、壊れた断片をコマンドとして実行する。実際にこうなった。
 *
 *   'de\' is not recognized as an internal or external command,
 *   '□か、' is not recognized as an internal or external command,
 *
 * だから分岐は goto で書き、日本語は括弧の外（ラベルの中）だけに置く。
 * 制御の骨は ASCII、人に見せる文だけ日本語。
 *
 * 文字集合も同じ話。cmd.exe はバッチを console の文字集合（日本語 Windows
 * なら CP932）で読む。UTF-8 で置くと、実機でこうなった。
 *
 *   >�き場所: C:\Users\...
 *   '�き場所:' is not recognized as an internal or external command,
 *
 * BOM を付けても直らず、1 行目まで壊れて @echo off が効かなくなった。
 *
 *   '・ｿ@echo' は、内部コマンドまたは外部コマンド...認識されていません
 *
 * だから **CP932 で置き、BOM は付けない**（.gitattributes の
 * working-tree-encoding で、記録は UTF-8 のまま取り出すときだけ変える）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { installRoot } from '../src/core/home.ts';

/** 配っているバッチを全部集める。増えたものも自動で対象になる。 */
async function batchFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const dir of ['.', 'installer']) {
    const at = join(installRoot(), dir);
    for (const name of await readdir(at).catch(() => [])) {
      if (name.toLowerCase().endsWith('.cmd') || name.toLowerCase().endsWith('.bat')) {
        out.push(join(at, name));
      }
    }
  }
  return out;
}

const nonAscii = (s: string) => /[^\x00-\x7F]/.test(s);

/** バッチは CP932 で置いてある。読むときも合わせる。 */
const read2 = (bytes: Uint8Array) => new TextDecoder('shift_jis').decode(bytes);
const read = async (path: string) => read2(await readFile(path));

/**
 * 括弧の中に日本語があるか。
 *
 * 前に書いた検査は、行をまたぐ塊しか見ていなかったので
 * `|| (echo 日本語 & pause)` を**見逃した**。実際に壊れたのはそちらだった。
 * 1行に閉じた括弧も見る。
 */
function insideParens(source: string): string[] {
  const bad: string[] = [];
  let depth = 0;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('rem ') || line.startsWith('::')) continue;

    // 1行で閉じている括弧の中身
    for (const m of line.matchAll(/\(([^()]*)\)/g)) {
      if (nonAscii(m[1]!)) bad.push(line);
    }
    // 行をまたぐ塊の中身
    if (depth > 0 && nonAscii(line)) bad.push(line);

    depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
    if (depth < 0) depth = 0;
  }
  return bad;
}

describe('バッチファイル', () => {
  test('括弧の中に日本語を置かない', async () => {
    for (const path of await batchFiles()) {
      const source = await read(path);
      const bad = insideParens(source);
      assert.deepEqual(bad, [], `${path} の括弧の中に日本語がある:\n  ${bad.join('\n  ')}`);
    }
  });

  test('BOM を付けない', async () => {
    // 付けると 1 行目が壊れ、@echo off が効かなくなる。実機で確認済み。
    for (const path of await batchFiles()) {
      const head = (await readFile(path)).subarray(0, 3);
      assert.notDeepEqual([...head], [0xef, 0xbb, 0xbf], `${path} に BOM がある`);
    }
  });

  test('UTF-8 で置かない（cmd.exe は console の文字集合で読む）', async () => {
    for (const path of await batchFiles()) {
      const bytes = await readFile(path);
      if (!bytes.some((b) => b >= 0x80)) continue; // ASCII だけなら、どちらでも同じ
      assert.throws(
        () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        `${path} が UTF-8 のまま。CP932 で置く（.gitattributes を見る）`,
      );
      // CP932 として読めること。読めない並びなら、置き方が壊れている。
      assert.ok(!read2(bytes).includes('\ufffd'), `${path} を CP932 として読めない`);
    }
  });

  test('飛び先の無い goto を残さない', async () => {
    // 飛び先が無いと、その場で止まらずに先へ流れてしまう。
    for (const path of await batchFiles()) {
      const source = await read(path);
      // 注釈は外す。中の英文に goto と書いてあるのを拾ってしまう
      // （実際に「Use goto labels」を飛び先だと思って落ちた）。
      const lines = source.split(/\r?\n/)
        .filter((l) => !l.trim().startsWith('rem ') && !l.trim().startsWith('::'));
      const labels = new Set(
        lines.filter((l) => l.startsWith(':')).map((l) => l.slice(1).trim().toLowerCase()),
      );
      const gotos = [...lines.join('\n').matchAll(/goto\s+:?(\w+)/gi)].map((m) => m[1]!.toLowerCase());
      const missing = [...new Set(gotos)].filter((g) => !labels.has(g) && g !== 'eof');
      assert.deepEqual(missing, [], `${path} の飛び先が無い: ${missing.join(', ')}`);
    }
  });

  test('.. を含んだまま探さない', async () => {
    // 実機（Z: の割り当てドライブ・OneDrive の下）で、同梱した
    // runtime\node.exe を見つけられなかった。%~dp0..\ のまま
    // if exist に渡していたのが原因。%%~fi で実際の道に直してから見る。
    for (const path of await batchFiles()) {
      const source = await read(path);
      const bad = source.split(/\r?\n/)
        .filter((l) => !l.trim().startsWith('rem '))
        .filter((l) => /if\s+exist\s+"[^"]*\.\.[\\/]/i.test(l));
      assert.deepEqual(bad, [], `${path} が .. のまま探している:\n  ${bad.join('\n  ')}`);
    }
  });

  test('この検査自体が、1行の括弧を見落とさない', () => {
    // 前の検査は行をまたぐ塊しか見ておらず、実際に壊れた形を見逃した。
    assert.equal(insideParens('where node || (echo みつかりません & pause)').length, 1);
    assert.equal(insideParens('if errorlevel 1 (\n  echo だめ\n)').length, 1);
    assert.equal(insideParens('if errorlevel 1 goto :ng\necho だめ').length, 0);
    assert.equal(insideParens('rem これは注釈なので (日本語) でよい').length, 0);
  });
});
