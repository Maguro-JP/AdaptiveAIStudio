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
import { launcherIn } from '../scripts/bundle.mjs';

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

  test('同じラベルを二つ置かない', async () => {
    // 継ぎ足しを繰り返して :badChoice と :exeStripped が二重になった。
    // cmd.exe は先に見つけたほうへ飛ぶので、後ろの中身は死ぬ。
    // 落ちもせず、ただ黙って別の場所へ流れる。
    for (const path of await batchFiles()) {
      const labels = (await read(path)).split(/\r?\n/)
        .filter((l) => /^:[A-Za-z]/.test(l))
        .map((l) => l.trim().toLowerCase());
      const seen = new Set<string>();
      const dup = labels.filter((l) => (seen.has(l) ? true : (seen.add(l), false)));
      assert.deepEqual(dup, [], `${path} に同じラベルが二つある: ${dup.join(', ')}`);
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

describe('入口は、ZIP の中から押されたときを受け止める', () => {
  /**
   * Windows は ZIP を**フォルダとして開けてしまう**。そこで .cmd を押すと、
   * Windows は**その1ファイルだけ**を temp へ出して走らせるので、隣にある
   * はずの `app\` も `runtime\` も無い。受け止めが無いと
   * 「指定されたパスが見つかりません」が一瞬映って窓が閉じ、
   * **何が起きたか誰にも分からない**。
   *
   * NetVision も同じところで「ZIP をダブルクリックして開いた中身から直接
   * 起動しても動きません。必ず『すべて展開』で取り出してから使ってください」と
   * 書いている。ここは Windows が無いと踏めないので、検査で押さえる。
   */
  const launcher = async (): Promise<string> => {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    // CP932 で置いてある。読むときも CP932 として読む。
    const raw = await readFile(launcherIn(root));
    return new TextDecoder('shift_jis').decode(raw);
  };

  test('**app が無ければ、何をすればいいか言ってから止まる**', async () => {
    const text = await launcher();
    const at = text.indexOf('if exist "%~dp0app\\start.cmd" goto :run');
    assert.ok(at >= 0, `app の有無を見ていない:\n${text}`);
    const before = text.slice(0, at);
    const after = text.slice(at);
    // 見る前に呼びに行っていないこと。
    assert.doesNotMatch(before, /call /, '確かめる前に呼びに行っている');
    assert.match(after, /すべて展開/, `どうすればいいか言っていない:\n${after}`);
    assert.match(after, /pause/, '止まらずに窓が閉じる');
    // `goto :run` ではなく、飛び先のラベル（行頭の :run）と比べる。
    assert.ok(after.indexOf('pause') < after.indexOf('\r\n:run'), '案内の後で止まっていない');
  });

  test('書き込める場所へ置くことも言う', async () => {
    assert.match(await launcher(), /Program Files/);
  });

  test('CP932 で置いてある（UTF-8 だと cmd.exe が行を壊す）', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const raw = await readFile(launcherIn(root));
    // UTF-8 として読めてしまうなら、CP932 ではない。
    let utf8Ok = true;
    try { new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { utf8Ok = false; }
    assert.equal(utf8Ok, false, 'UTF-8 で置かれている');
    assert.doesNotMatch(new TextDecoder('shift_jis').decode(raw), /\uFFFD/, 'CP932 として読めない');
  });

  /*
   * **ここで bundle を丸ごと組まない。**
   *
   * 前は、この一行を確かめるために 200MB を組んでいた。この機械では 30 秒、
   * **配る先（Windows・クラウドドライブの下）では 233 秒かかって落ちた。**
   * 何が落ちたのかも分からない。組み上がるかどうかは `npm run check:bundle`
   * の持ち場で、ここで見たいのは「入口を組み立て直していないか」だけ。
   */
  test('入口は、組み立て直さずにそのまま置く', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const src = await readFile(join(root, 'scripts', 'bundle.mjs'), 'utf8');
    // 置き方は copyFile。writeFile で作り直すと、CP932 が UTF-8 になって壊れる。
    assert.match(src, /copyFile\(launcherIn\(srcRoot\), join\(out, 'AdaptiveAIStudio\.cmd'\)\)/,
      '入口を copyFile で置いていない');
    assert.doesNotMatch(src, /writeFile\([^)]*'AdaptiveAIStudio\.cmd'/,
      '入口を組み立て直している（CP932 が壊れる）');
    // 元のファイルが CP932 のままであること（ここは test/batch.test.ts の他の
    // ほかと同じ見方）。組んだものの中身は check:bundle が見る。
    const bytes = await readFile(launcherIn(root));
    assert.ok(bytes.length > 0, '入口が空');
  });
});

/**
 * 入っている Node を、探す前に諦めない。
 *
 * `start.cmd` は `.portable` のファイルがあると、**`where node` を一度も試さず**
 * 「同梱の Node がありません。クラウドドライブが .exe を落としたのでは」
 * と言って止まっていた。
 *
 * Node を同梱していない版を Windows で動かしてもらったら、そこで止まった。
 * その機械には Node が入っている。案内が的外れなうえ、**使えるものが在るのに
 * 使わない。**
 *
 * ## ここで見られること・見られないこと
 *
 * `.cmd` は Windows でしか走らないので、**振る舞いは確かめられない。**
 * 見られるのは並び順だけ。弱いが、この不具合はこの形でしか入らないので、
 * ここで止める。**本当に動くかは Windows で動かすまで分からない。**
 */
describe('入っている Node を、探す前に諦めない', () => {
  test('**`.portable` から、そのまま諦めへ飛ばない**', async () => {
    const text = await readFile(join(installRoot(), 'start.cmd'), 'latin1');
    // CP932 でも ASCII の部分はそのまま読める。制御の骨は ASCII で書いてある。
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((l) => /\.portable/.test(l) && /goto\s+:exeStripped/i.test(l));
    assert.equal(at, -1,
      `.portable を見た時点で諦めている（${at + 1} 行目）。先に where node を試すこと`);
  });

  test('**諦める前に、`where node` を試している**', async () => {
    const text = await readFile(join(installRoot(), 'start.cmd'), 'latin1');
    const lines = text.split(/\r?\n/);
    const looked = lines.findIndex((l) => /where\s+node/i.test(l));
    const giveUp = lines.findIndex((l) => /^:exeStripped/i.test(l));
    assert.ok(looked >= 0, 'where node を一度も書いていない');
    assert.ok(giveUp >= 0, 'この確かめの前提が崩れている（:exeStripped が無い）');
    assert.ok(looked < giveUp,
      `諦める所（${giveUp + 1} 行目）より後で探している（${looked + 1} 行目）`);
  });

  test('入っている Node も無いときの案内に、入れ方がある（対）', async () => {
    // 「.exe が落とされたのでは」だけだと、Node を入れれば済む人が詰む。
    const text = await readFile(join(installRoot(), 'start.cmd'), 'latin1');
    /*
     * **ラベルの方を探す。**`indexOf` だと、先に出てくる `goto :exeStripped`
     * に当たって、案内の中身を一文字も見ないまま通る（実際にそうなった）。
     */
    const at = text.search(/^:exeStripped/m);
    assert.ok(at >= 0, ':exeStripped のラベルが無い');
    const block = text.slice(at);
    assert.match(block, /nodejs\.org/, '入れ方を書いていない');
  });

  test('**動かせなかったのがどの Node かで、言うことを変える**', async () => {
    /*
     * `-v` が返らないときに「同梱の Node を動かせませんでした」と決めつけて
     * いた。PATH の node が動かないとき（版を選んでいない nvm など）にも
     * 同じ文が出て、パスは空のまま `\node.exe` と表示される。
     * 案内が的外れなうえ、何を見ればいいかも分からない。
     */
    const text = await readFile(join(installRoot(), 'start.cmd'), 'latin1');
    const at = text.search(/^:nodeSilent/m);
    assert.ok(at >= 0, ':nodeSilent のラベルが無い');
    const block = text.slice(at);
    assert.match(block.split(/\r?\n/).slice(0, 12).join('\n'), /if\s+defined\s+BUNDLED/i,
      '同梱かどうかを見ないまま、同梱のせいにしている');
  });
});

describe('入口の番号', () => {
  /**
   * **押しても何も起きない番号を、並べない。**
   *
   * 番号と仕事の対応は入口（`start.cmd` / `start.sh`）に、仕事の中身は
   * `package.json` に書いてある。二箇所に分かれているので、片方だけ足すと
   * 「番号はあるのに何も起きない」になる。押した人には理由が分からない。
   */
  test('番号から呼ばれる仕事が、package.json にある', async () => {
    const root = installRoot();
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const cmd = await readFile(join(root, 'start.cmd'), 'utf8');
    const sh = await readFile(join(root, 'start.sh'), 'utf8');

    const tasks = [
      ...[...cmd.matchAll(/CHOICE%"=="\d"\s+set\s+"TASK=(\w+)"/g)].map((m) => `start.cmd:${m[1]}`),
      ...[...sh.matchAll(/^\s*\d\)\s*task=(\w+)\s*;;/gm)].map((m) => `start.sh:${m[1]}`),
    ];
    assert.ok(tasks.length >= 4, `番号の対応が読めていません: ${tasks.length}`);
    for (const t of tasks) {
      const name = t.split(':')[1]!;
      assert.ok(pkg.scripts[name], `${t} は package.json に無い仕事です`);
    }
  });
});

/**
 * 2つ目からの引数を、落とさずに渡すこと。
 *
 * 入口は `set "TASK=%~1"` で**第1引数しか拾っていなかった**。
 * 配った形（npm の無い機械）で片づけるには `clean --yes` を渡すしかないのに、
 * `--yes` が落ちるので**一度も消せない**。画面の「溜まったものを片づける」も
 * 見せるだけで終わり、次の一手が打てない形になっていた。
 */
describe('入口は、渡された引数をそのまま渡す', () => {
  const source = async (): Promise<string> => {
    const raw = await readFile(join(installRoot(), 'start.cmd'));
    return new TextDecoder('shift_jis').decode(raw);
  };

  test('**2つ目からの引数を集めている**', async () => {
    const text = await source();
    assert.match(text, /^:collect$/m, '集める所が無い');
    assert.match(text, /set "ARGS=%ARGS% %~1"/, '集めていない');
    assert.match(text, /^shift$/m, 'ずらしていない（同じ引数を数え続ける）');
  });

  test('**集めたものを、走らせる所へ渡している**', async () => {
    const text = await source();
    // npm 無しの道。`run.mjs <名前> <引数…>` は既に引数を通す。
    assert.match(text, /run\.mjs %TASK%%ARGS%/, 'npm 無しの道へ渡していない');
    // npm の道は `npm run <名前> -- <引数…>`。
    assert.match(text, /if defined ARGS call "%NPM%" run %TASK% --%ARGS%/, 'npm の道へ渡していない');
  });

  test('引数が無いときは、これまでどおり（対）', async () => {
    const text = await source();
    assert.match(text, /if not defined ARGS call "%NPM%" run %TASK%$/m,
      '引数が無いときに -- を付けている');
  });
});
