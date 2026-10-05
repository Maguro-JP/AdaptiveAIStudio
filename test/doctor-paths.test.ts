/**
 * OneDrive の中に置いてあることを、doctor が言う。
 *
 * 遅い理由がフォルダの場所にあるとき、モデルや機械のせいにしてしまう。
 * 名前で分かることは、名前で言う。実際に遅いかどうかまでは言わない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { insideOneDrive, modelsDirNote, programDirNote } from '../src/cli/doctor-paths.ts';

describe('OneDrive の中か', () => {
  test('Windows の道（会社の OneDrive の名前）', () => {
    assert.equal(insideOneDrive('Z:\\maguro\\OneDrive - Business1\\Documents\\AdaptiveAIStudio\\data\\models'), true);
  });
  test('区切りが / でも、大文字小文字が違っても', () => {
    assert.equal(insideOneDrive('/home/x/onedrive/models'), true);
    assert.equal(insideOneDrive('C:/Users/x/OneDrive/Desktop'), true);
  });
  test('普通のフォルダは言わない（対）', () => {
    assert.equal(insideOneDrive('C:\\Users\\x\\AppData\\Local\\Programs\\AdaptiveAIStudio\\data\\models'), false);
    assert.equal(insideOneDrive('/home/user/AdaptiveAIStudio'), false);
    // 名前の一部に紛れていても、フォルダ名そのものでなければ言わない。
    assert.equal(insideOneDrive('/srv/one-drive-notes'), false);
  });
});

describe('言うこと', () => {
  test('モデルのフォルダなら、常に保持する直し方を添える', () => {
    const n = modelsDirNote('Z:\\maguro\\OneDrive - Business1\\models');
    assert.ok(n);
    assert.match(n.text, /OneDrive の中にあります/);
    assert.match(n.hint, /このデバイス上に常に保持する/);
    assert.match(n.hint, /ことがあります/, '実際に遅いと言い切っている');
  });
  test('プログラムのフォルダも同じ形で、理由は別', () => {
    const n = programDirNote('Z:\\maguro\\OneDrive - Business1\\AdaptiveAIStudio');
    assert.ok(n);
    assert.match(n.hint, /小さいファイル/);
  });
  test('外なら何も言わない（対）', () => {
    assert.equal(modelsDirNote('D:\\models'), undefined);
    assert.equal(programDirNote('D:\\AdaptiveAIStudio'), undefined);
  });
});

/**
 * 案内する一手が、その形で打てること。
 *
 * `how()` は `isPortable()` でしか分けていなかった。あれは `.portable` が在るかどうかで決まるが、**インストーラ用の一式からは `.portable` を消している**
 * （`scripts/installer.mjs`）。つまり setup.exe で入れた形では
 * `npm run ui` を案内していた。入れた形にも npm は無いので、
 * **案内した手がその場で打てない。**
 *
 * clean も同じで、`npm run clean -- --yes` と書き写していた。
 * 配った形では、片づける道がどこにも無い形になっていた。
 */
describe('案内する一手は、その形で打てる', () => {
  test('**配った形（app/ の中）では、入口の呼び方で言う**', async () => {
    const { how } = await import('../src/cli/how.ts');
    const { join } = await import('node:path');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { tempDir } = await import('./tmp.ts');
    // 配った形の見分けは `installRoot()` の名前が app かどうか。
    // ここは分岐そのものを見る（`isDistributed`）。
    const { isDistributed } = await import('../src/core/home.ts');
    const base = await tempDir('aas-how-');
    const app = join(base, 'app');
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'package.json'), '{}');
    await writeFile(join(base, 'AdaptiveAIStudio.cmd'), '@echo off\r\n'); // 配った形は app/ の隣に入口がある
    assert.equal(isDistributed(app), true, 'app/ を配った形と見ていない');
    // **打てる形で言っているか**を、置かれ方ごとに見る。
    assert.equal(how('ui', '', app), 'AdaptiveAIStudio.cmd ui',
      '入れた形なのに npm を案内している');
    assert.equal(how('clean', '--yes', app), 'AdaptiveAIStudio.cmd clean --yes');
    // クローン（app ではない）は、これまでどおり npm。
    assert.equal(isDistributed(base), false);
    assert.equal(how('ui', '', base), 'npm run ui');
    assert.equal(how('clean', '--yes', base), 'npm run clean -- --yes');
  });

  test('**clean は how を通す（書き写さない）**', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { installRoot } = await import('../src/core/home.ts');
    const src = await readFile(join(installRoot(), 'src', 'cli', 'clean.ts'), 'utf8');
    assert.doesNotMatch(src, /npm run clean/, '打てない一手を書き写している');
    assert.match(src, /how\('clean', '--yes'\)/, 'how を通していない');
  });

  test('**doctor も how を通す（isPortable で分けない）**', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { installRoot } = await import('../src/core/home.ts');
    const src = await readFile(join(installRoot(), 'src', 'cli', 'doctor.ts'), 'utf8');
    assert.doesNotMatch(src, /function how\(/, 'doctor が自分の how を持っている（二重になる）');
    assert.match(src, /from '\.\/how\.ts'/, '共有の how を使っていない');
  });
});

/**
 * 在ることと、動くことは別。
 *
 * doctor は `findInstalled()` が返した道を、そのまま `ok` にしていた。
 * あれは `stat` して道を返すだけなので、**0 バイトで実行権の無いファイルでも
 * ok になり、締めは「動かせます」。**実際に起こすと終了コード 126。
 * 壊れているのに緑なので、直しに行く先がどこにも出ない。
 * selftest は同じ場所で `--version` を走らせて決めているのに、doctor だけが
 * 見ていなかった。
 */
describe('doctor は llama-server を一度起こす', () => {
  async function runDoctor(home: string): Promise<string> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { join } = await import('node:path');
    const { installRoot } = await import('../src/core/home.ts');
    const run = promisify(execFile);
    const clean = { ...process.env };
    delete clean.NODE_TEST_CONTEXT;
    delete clean.NODE_OPTIONS;
    const out = await run(process.execPath, [
      '--experimental-strip-types', '--no-warnings', join(installRoot(), 'src', 'cli', 'doctor.ts'),
    ], {
      env: {
        ...clean, NO_COLOR: '1',
        AAS_HOME: home, AAS_CONFIG: join(home, 'aas.config.json'),
        AAS_REPORT_DIR: join(home, 'reports'),
      },
      timeout: 300_000,
    }).catch((e: { stdout?: string; stderr?: string }) => e);
    return `${out.stdout ?? ''}${out.stderr ?? ''}`;
  }

  test('**0 バイトで実行権の無いものを ok と言わない**', async () => {
    const { mkdir, writeFile, chmod } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tempDir } = await import('./tmp.ts');
    const home = await tempDir('aas-llama-');
    const bin = join(home, 'bin', 'b4585');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'llama-server'), '');
    await chmod(join(bin, 'llama-server'), 0o644);
    await writeFile(join(home, 'aas.config.json'), JSON.stringify({ runtime: { kind: 'llamacpp' } }));

    const text = await runDoctor(home);
    assert.match(text, /llama-server/, `見ていない:\n${text.slice(-500)}`);
    assert.doesNotMatch(text, /ok\s+llama-server/, `壊れているのに ok と言っている:\n${text.slice(-600)}`);
    assert.match(text, /動きません/, `動かないと言っていない:\n${text.slice(-600)}`);
  });
});
