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
import { tempDir } from './tmp.ts';
import { aasHome, stateDir, binDir, modelsDir, isPortable, installRoot, isAsciiPath, asciiModelsDir } from '../src/core/home.ts';
import { lookup, toCommand } from '../scripts/run.mjs';

/**
 * 作業場にしか無いものを見る試験の印。
 *
 * CI の設定も、用意用も、配布物には**入れるべきでない**。
 * だから配布物の中で走らせると、確かめようがない。
 * そこで落とすのは嘘（何も壊れていない）なので、飛ばしてそう言う。
 */
const sourceOnly = existsSync(join(installRoot(), '.github'))
  ? {}
  : { skip: '作業場にしか無いものを見る試験です（配布物では確かめられません）' };

const KEYS = ['AAS_HOME', 'AAS_STATE_DIR', 'AAS_BIN_DIR', 'AAS_MODELS_DIR'];
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

  test('用意用は、全角の混ざる置き場所を先に止める', sourceOnly, async () => {
    // 後で分かると数GB落とし直しになるので、取ってくる前に止める。
    const raw = cmd(await readFile(join(installRoot(), 'installer', 'bootstrap.cmd')));
    assert.match(raw, /findstr \/R "\[\^ -~\]"/, '全角の検査が無い');
    const stopAt = raw.indexOf('findstr /R "[^ -~]"');
    const fetchAt = raw.indexOf('curl -fL');
    assert.ok(stopAt < fetchAt, '取ってきた後に検査している');
  });

  test('用意用は、git も npm も要求しない', sourceOnly, async () => {
    const raw = cmd(await readFile(join(installRoot(), 'installer', 'bootstrap.cmd')));
    // 動く行だけを見る。案内文（echo）に「npm run bundle」と書くのは、
    // 使う側への説明であって、この道具が npm を要ることにはならない。
    const runs = raw.split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('rem ') && !l.startsWith('::')
        && !l.toLowerCase().startsWith('echo'));
    for (const line of runs) {
      assert.equal(/\bgit\b/.test(line), false, `git を使っている: ${line}`);
      assert.equal(/\bnpm\b/.test(line), false, `npm を使っている: ${line}`);
    }
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

describe('配布物の形', () => {
  test('利用者が最初に見るものは、普通の名前になっている', async () => {
    const out = await tempDir('aas-bundle-');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-1' });

    const { readdir } = await import('node:fs/promises');
    const top = (await readdir(out)).sort();
    // 日本語のファイル名を表に置かない。中身は日本語でよい。
    assert.deepEqual(top, ['.portable', 'AdaptiveAIStudio.cmd', 'README.txt', 'VERSION', 'app']);
  });

  test('版は VERSION に、そのまま書いてある', async () => {
    const out = await tempDir('aas-bundle-');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-2' });
    assert.equal((await readFile(join(out, 'VERSION'), 'utf8')).trim(), 'test-2');
  });

  test('data は app の外に出る', async () => {
    const out = await tempDir('aas-bundle-');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-3' });
    // 中身（app）の中に記録が混ざると、更新のたびに巻き添えで消える。
    assert.equal(aasHome(join(out, 'app')), join(out, 'data'));
  });
});

describe('CI の使い方', () => {
  test('押すたびに配布物を組み立てない', sourceOnly, async () => {
    // Windows の枠は2倍で数えられる。前に使い切って1日検査できなくなった。
    const raw = await readFile(join(installRoot(), '.github', 'workflows', 'release.yml'), 'utf8');
    assert.equal(/^\s*branches:/m.test(raw), false, '枝への push で組み立てている');
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
});

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
    // JST = UTC+9。月曜 09:00 JST → 月曜 00:00 UTC。
    assert.equal(hourUtc, '0');
    assert.equal(dowUtc, '1', 'JST の月曜にしたいなら UTC も月曜（0時なので日をまたがない）');
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

  test('組み立てたものを、通しで動かせる', async () => {
    // これが無かったのが根本。入口が死んでいても、部品の試験は全部通る。
    // 実機では「1 を選んでも何も起きない」という形で出た。
    const out = await tempDir('aas-e2e-');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), nodeHere: true, version: 'e2e' });

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
  // 一度、三箇所で食い違った（start.cmd は app/node、bundle は runtime、
  // bootstrap は node）。同梱したのに見つけられない状態だった。

  test('組み立てると runtime に入る', async () => {
    const out = await tempDir('aas-node-');
    const fake = join(await tempDir('aas-fake-'), 'node.exe');
    await writeFile(fake, 'dummy');
    const { bundle } = await import('../scripts/bundle.mjs');
    const r = await bundle({ out, srcRoot: installRoot(), nodeExe: fake, version: 'x' });
    assert.equal(r.bundledNode, true);
    const { stat } = await import('node:fs/promises');
    assert.ok(await stat(join(out, 'runtime', 'node.exe')));
  });

  test('名前を変えても入る（.exe を落とす場所むけ）', async () => {
    // 会社のクラウドドライブは **名前を見て** .exe を落とす。
    // 中身は同じで名前だけ違うものを置けるようにしてある。
    const out = await tempDir('aas-bin-');
    const fake = join(await tempDir('aas-fake-'), 'node.exe');
    await writeFile(fake, 'dummy');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), nodeExe: fake, nodeName: 'node.bin', version: 'x' });
    const { stat } = await import('node:fs/promises');
    assert.ok(await stat(join(out, 'runtime', 'node.bin')));
    // 既定は変えない。何も渡さなければ node.exe のまま。
    const plain = await tempDir('aas-bin2-');
    await bundle({ out: plain, srcRoot: installRoot(), nodeExe: fake, version: 'x' });
    assert.ok(await stat(join(plain, 'runtime', 'node.exe')));
  });

  test('入口は、.exe が落とされた場所でも動く', sourceOnly, async () => {
    const raw = cmd(await readFile(join(installRoot(), 'start.cmd')));
    assert.match(raw, /%UP%\\runtime\\node\.bin/, '.bin を探していない');
    assert.match(raw, /PATHEXT=%PATHEXT%;\.BIN/, 'PATHEXT に足していない');
  });

  test('入口は、組み立てた場所を探しに行く', sourceOnly, async () => {
    const raw = cmd(await readFile(join(installRoot(), 'start.cmd')));
    // app\ の隣の runtime\ を見ていること。
    // ただし `..` を含んだままでは見に行かない。実機（Z: の割り当て
    // ドライブ・OneDrive の下）で、同梱したのに見つけられなかった。
    assert.match(raw, /for %%i in \("%~dp0\.\."\) do set "UP=%%~fi"/, '.. を潰していない');
    assert.match(raw, /%UP%\\runtime\\node\.exe/, '製品の形を見ていない');
  });

  test('用意用は、組み立て方を書き写さない', sourceOnly, async () => {
    // 書き写すと、配布物と食い違う。実際に一度そうなった。
    const raw = cmd(await readFile(join(installRoot(), 'installer', 'bootstrap.cmd')));
    assert.match(raw, /scripts\\bundle\.mjs/, '組み立て器を使っていない');
    assert.match(raw, /--node-exe/);
    assert.match(raw, /--src/);
  });

  test('用意用が置く場所と、入口が探す場所が同じ', sourceOnly, async () => {
    const boot = cmd(await readFile(join(installRoot(), 'installer', 'bootstrap.cmd')));
    assert.match(boot, /%DEST%\\runtime\\node\.exe/, '確かめる場所がずれている');
    assert.match(boot, /%DEST%\\app\\scripts\\/, '中身の場所がずれている');
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

describe('CI が使えなくても、配布物は作れる', () => {
  test('いま動かしている Node ごと固められる', async () => {
    // 枠を使い切ると何も確かめられなくなる、を避けるための道。
    // 取ってこない（網が要らない）ので、CI にも外にも依存しない。
    const out = await tempDir('aas-self-');
    const { bundle } = await import('../scripts/bundle.mjs');
    const r = await bundle({ out, srcRoot: installRoot(), nodeHere: true, version: 'x' });
    assert.equal(r.bundledNode, true);

    const { readdir } = await import('node:fs/promises');
    const runtime = await readdir(join(out, 'runtime'));
    assert.ok(runtime.some((n) => n === 'node' || n === 'node.exe'), '同梱されていない');
  });

  test('固めたものだけで、検査を回せる形になっている', async () => {
    // 持って行った先で確かめられないなら、持って行く意味がない。
    const out = await tempDir('aas-self-');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'x' });
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
    assert.equal(asciiModelsDir('C:\\Users\\maguro\\.aas', env), undefined);
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

describe('配布物の形のまま、この中で読む設定で通す', () => {
  test('組み立てたものに GGUF を置いて doctor が通る', sourceOnly, async () => {
    // 過去の不具合は、**配った形でだけ壊れる**ものに集まっている
    // （入口が丸ごと死ぬ、置き場がずれる、繋ぎ先が埋まらない）。
    // 作業コピーで通ることは、配った形で通ることの証明にならない。
    const out = await tempDir('aas-dist-');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), nodeHere: true, version: 'dist-e2e' });

    const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
    const models = join(out, 'data', 'models');
    await mk(models, { recursive: true });
    await wf(join(models, 'qwen2.5-3b-instruct-q4_k_m.gguf'), 'x');
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
