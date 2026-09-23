/**
 * 先読みは、**変えたかもしれない**ものの後で捨てる。
 *
 * 捨てる条件が `isWriteTool` だった。当たるのは `write_file` と `edit_file` の
 * 二つだけなので、`run_command` で作った・消したファイルと、外のツールが
 * 触ったファイルは、**古いままモデルへ渡る。**在るファイルを無いものとして
 * 考えるので、同じものをもう一度作る・無いと言い張る、が起きる。
 *
 * 捨てて外したときの損は作り直す手間だけ。**分からないものは、変えたかも
 * しれない側に置く。**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EXTERNAL_SEPARATOR, mayChangeFiles, mayWriteFiles, isWriteTool, changesFilesHere,
} from '../src/agent/tools/write-kind.ts';

describe('変えたかもしれないものの見分け方', () => {
  test('**書くツール・走らせるツール・外のツールは、変えたかもしれない**', () => {
    for (const name of ['write_file', 'edit_file', 'run_command',
      `notes${EXTERNAL_SEPARATOR}save`]) {
      assert.equal(mayChangeFiles(name), true, `${name} を変えないものとして扱っている`);
    }
  });

  test('読むだけのツールは、変えない（対）', () => {
    // ここまで広げると、読むたびに先読みを作り直すことになる。
    for (const name of ['read_file', 'list_files', 'search_text', 'find_code',
      'find_symbol', 'show_file']) {
      assert.equal(mayChangeFiles(name), false, `${name} を変えるものとして扱っている`);
    }
  });

  test('外へ出るだけ・画面だけのツールも、ディスクは変えない（対）', () => {
    // `fetch_url` は取ってくるだけ。`replace_selection` は人の書きかけの欄。
    // `deliberate` は相談。どれもファイルには触らない。
    for (const name of ['fetch_url', 'replace_selection', 'deliberate']) {
      assert.equal(mayChangeFiles(name), false, `${name} を変えるものとして扱っている`);
    }
  });

  test('書くかどうかの判じ方は、別のまま', () => {
    // 巻き戻しと差分は path が要るので、そちらは広げていない。
    assert.equal(mayWriteFiles('run_command'), false, 'run_command を書くツールにしてしまった');
    assert.equal(isWriteTool('run_command'), false);
  });
});

describe('捨てる場所が、全部その判じ方を使っている', () => {
  test('**先読みを捨てる行は、どれも mayChangeFiles で決めている**', async () => {
    /*
     * 判じ方を足しても、呼ぶ場所が古ければ何も変わらない。**呼ぶ行を見る。**
     * 前に、案内だけ残して探しに行く行を消しても通る形を作った。
     */
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'core', 'session.ts'), 'utf8');
    const lines = src.split('\n');
    /*
     * 見るのは**ツールの名前で決めている行**だけ。ターンの終わりの一回は
     * 条件なしで捨てる（いつでも正しい）ので、そこに判じ方を求めない。
     */
    const at = lines
      .map((line, i) => ({ line, i, near: lines.slice(Math.max(0, i - 4), i + 1).join('\n') }))
      .filter(({ line }) => line.includes('#prefetch.invalidate()'))
      .filter(({ near }) => /call\.name/.test(near));
    assert.ok(at.length >= 3, `名前で決めている行が拾えていない: ${at.length} 箇所`);

    for (const { line, i, near } of at) {
      assert.match(near, /mayChangeFiles/,
        `session.ts:${i + 1} が mayChangeFiles で決めていません: ${line.trim()}`);
      assert.doesNotMatch(near, /isWriteTool\s*\([^)]*\)\s*\)?\s*(&&|\|\||\))?\s*this\.#prefetch/,
        `session.ts:${i + 1} がまだ isWriteTool で絞っています: ${line.trim()}`);
    }

    // 条件なしで捨てる行が在ること自体は、正しい姿なので残す。
    assert.ok(
      lines.some((l) => l.trim() === 'this.#prefetch.invalidate();'),
      'ターンの終わりに、条件なしで捨てる行が無くなっています',
    );
  });

  test('**作業前の記録は、この場所のツールだけで決めている**', async () => {
    /*
     * 記録は分けてある。先読みを捨てるのは作り直すだけだが、**記録はその場で
     * テストを一度走らせる。**外のツールの手前に置くと 1ターンが何十秒も伸びる
     * （広げた回に、外のツールを呼ぶ e2e が記録を待つ間に打ち切られた）。
     *
     * 呼ぶ行を名指しで見る。うっかり `mayChangeFiles` に戻すと、
     * また同じところで打ち切られる。
     */
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'core', 'session.ts'), 'utf8');
    assert.match(src, /const changesFiles = changesFilesHere;/,
      '作業前の記録が、別の判じ方で決まっています');
    assert.doesNotMatch(src, /const changesFiles = mayChangeFiles;/,
      '記録を外のツールまで広げています（e2e がそこで打ち切られます）');
  });

  test('先読みと記録で、外のツールの扱いが違う', () => {
    const outside = `notes${EXTERNAL_SEPARATOR}save`;
    assert.equal(mayChangeFiles(outside), true, '先読みを捨てない側にしている');
    assert.equal(changesFilesHere(outside), false, '記録を外のツールまで広げている');
    // この場所のツールでは、二つは同じ答えになる。
    for (const name of ['write_file', 'edit_file', 'run_command', 'read_file']) {
      assert.equal(mayChangeFiles(name), changesFilesHere(name), `${name} で食い違う`);
    }
  });
});
