/**
 * doctor が、この中で読む道（inproc）を知っていること。
 *
 * 案内が古いままだと、**使える道があるのに「土台がありません」と言う**。
 * 実際にそうなっていた（Ollama と llama.cpp しか出さなかった）。
 *
 * doctor は上から下まで走る書き方なので、子として起こして出力を読む。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { installRoot } from '../src/core/home.ts';

async function runDoctor(env: Record<string, string>): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const at = join(installRoot(), 'src', 'cli', 'doctor.ts');
  const out = await run(process.execPath, ['--no-warnings', at], {
    // 報告をプログラムの隣に撒かない（実際に撒いて、利用者に送られてきた）。
    env: { ...process.env, AAS_REPORT_DIR: join(tmpdir(), 'aas-doc-reports'), ...env, NO_COLOR: '1' },
    // CPU だけの Windows では、読むものの確かめだけで 60 秒を超えた（実測）。
    timeout: 300_000,
  }).catch((e: { stdout?: string; stderr?: string }) => e);
  // 未了があると終了コードが立つ。中身は読めるので、そのまま使う。
  // eslint-disable-next-line no-control-regex
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  // 途中で落ちた出力を「通った」と読まない。締めの一行まで出ていること。
  // 型のずれ（import 漏れ）で途中で落ちていても、文字の一致だけなら通ってしまう。
  assert.match(text, /動かせます|かたづければ動きます/, `締めまで出ていない:\n${text.slice(-600)}`);
  return text;
}

async function scratch(): Promise<{ home: string; models: string; config: string }> {
  const dir = await tempDir('aas-doc-');
  const models = join(dir, 'models');
  await mkdir(models, { recursive: true });
  return { home: join(dir, 'home'), models, config: join(dir, 'aas.config.json') };
}

describe('doctor は、この中で読む道を知っている', () => {
  test('設定が無ければ、この中で読むのが既定。置き場に GGUF を置けと言う', async () => {
    // 既定が Ollama だった頃は、製品の形で何もしないと「Provider が起動しているか」で
    // 止まっていた。二つ目の実行ファイルの要らない道を既定にする。
    const { home } = await scratch();
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: join(home, 'なし.json') });
    assert.match(text, /既定値 \(aas\.config\.json なし/);
    assert.match(text, /GGUF がありません/);
    assert.match(text, /この中で読む/);
  });

  test('動かし方を書いていない設定でも、この中で読む道になる', async () => {
    /*
     * 前は、ここで Ollama 扱いになっていた（設定が無いときは inproc なのに、
     * ファイルが在って書いていないときだけ別の道）。Ollama を入れていない
     * 機械では、モデルを取ってくる所も `ollama pull` へ行って必ず失敗し、
     * **GGUF を1つ置けば動く道に辿り着けない。**
     */
    const { home, config } = await scratch();
    await writeFile(config, JSON.stringify({ runtime: {} }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    assert.match(text, /GGUF がありません/);
    assert.doesNotMatch(text, /Ollama を入れて/, 'Ollama を入れろと言っている');
  });

  test('Ollama と書いてあって何も無いときは、両方の道を案内する', async () => {
    // 選べることを、片方だけ出して必須のように見せない。
    const { home, config } = await scratch();
    await writeFile(config, JSON.stringify({ runtime: { kind: 'ollama' } }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    assert.match(text, /モデルを動かす土台がまだありません/);
    assert.match(text, /この中で読む（実行ファイルは増えません）/);
    assert.match(text, /"kind": "inproc"/);
    // 何も入れられない機械が、いちばん困る。だから先に出す。
    const a = text.indexOf('A. この中で読む');
    const b = text.indexOf('B. Ollama');
    assert.ok(a > 0 && b > a, '増える実行ファイルが少ない順に並んでいない');
  });

  test('GGUF を1つ置けば、それで通る', async () => {
    const { home, models, config } = await scratch();
    await writeFile(join(models, 'qwen2.5-3b-instruct-q4_k_m.gguf'), 'GGUF');
    await writeFile(config, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: models } }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    assert.match(text, /1 件: qwen2\.5-3b-instruct-q4_k_m\.gguf/);
    // 「動かせます」は、モデルを読むライブラリ（node-llama-cpp）が在って初めて言える。
    // 素の npm ci（bundle 前）では入っていないので、doctor は正しく「入れてください」と言う。
    // ここを決め打つと、ライブラリの無い CI で必ず落ちる（実際に落ちた）。
    if (hasLib) assert.match(text, /動かせます。/);
    else assert.match(text, /node-llama-cpp が入っていません/);
  });

  test('繋ぎ先を、外へ見に行かない', async () => {
    // 口はこのプログラムの中に立つ。外から見に行っても、モデルを読むまで
    // 立たないので必ず「繋がりません」になる。**それは不足ではない。**
    const { home, models, config } = await scratch();
    await writeFile(join(models, 'm.gguf'), 'GGUF');
    await writeFile(config, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: models } }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    // 札が設定の id（ollama）のままだと「Ollama を入れなければ」と読まれる。
    // ここは接続の札が inproc で、口がこの中に立つこと。ライブラリの有無に依らない。
    assert.match(text, /接続 \(この中で読む\)/);
    assert.doesNotMatch(text, /接続 \(ollama\)/);
    assert.match(text, /この中に立てます/);
    // ライブラリが在れば不足ゼロで「動かせます」。無い環境では node-llama-cpp が
    // 唯一の不足として挙がる（外を見に行った結果ではない）。
    if (hasLib) assert.doesNotMatch(text, /件かたづければ動きます/);
    else assert.match(text, /node-llama-cpp が入っていません/);
  });

  test('llamacpp のときは、使っていない Ollama を不足として数えない', async () => {
    const { home, models, config } = await scratch();
    await writeFile(join(models, 'm.gguf'), 'GGUF');
    await writeFile(config, JSON.stringify({ runtime: { kind: 'llamacpp', modelsDir: models } }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    assert.match(text, /繋がりません（使っていません）/);
  });
});

// describe の中では await できない。上で決めておく。
const libDir = join(installRoot(), 'node_modules', 'node-llama-cpp');
const hasLib = await import('node:fs/promises').then((fs) => fs.stat(libDir)).then(() => true, () => false);
const onlyWithLib = { skip: hasLib ? false : 'node-llama-cpp が入っていません' };

describe('doctor は「入っていない」と「壊れている」を分ける', () => {

  test('本体が読めるなら「入っていません」とは言わない', onlyWithLib, async () => {
    const { home, models, config } = await scratch();
    await writeFile(join(models, 'a.gguf'), 'GGUF');
    await writeFile(config, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: models } }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    assert.doesNotMatch(text, /node-llama-cpp が入っていません/);
    assert.doesNotMatch(text, /在るのに読み込めません/);
    // この機械むけの binary が在れば ok、無ければ warn。どちらかであること。
    assert.match(text, /この機械むけの binary (が動きます|がありません)/);
    // 向こうの声（console.warn 直書き）を、貼る出力に混ぜない。
    assert.doesNotMatch(text, /prebuilt binary/i, 'ライブラリの警告がそのまま出ている');
  });
});

describe('doctor は、置いた GGUF の中身も見る', () => {
  test('名前だけ .gguf の別物に印を付ける', async () => {
    const { home, models, config } = await scratch();
    await writeFile(join(models, 'page.gguf'), '<!doctype html>');
    await writeFile(config, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: models } }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    assert.match(text, /page\.gguf は GGUF ではありません/);
  });
  test('本物には付けない（対）', async () => {
    const { home, models, config } = await scratch();
    await writeFile(join(models, 'real.gguf'), 'GGUF');
    await writeFile(config, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: models } }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    assert.doesNotMatch(text, /GGUF ではありません/);
  });
});

describe('置き場を書いていない（既定）ときも、中身を見る', () => {
  test('既定の置き場の GGUF でも、締めまで出る', async () => {
    // config.runtime.modelsDir が無い経路。ここで既定の置き場を引く関数が
    // 無い（import 漏れ）まま、検査は書いた置き場ばかりで通っていた。
    const { home } = await scratch();
    const { modelsDir } = await import('../src/core/home.ts');
    const prevHome = process.env.AAS_HOME;
    process.env.AAS_HOME = home;
    try {
      const dir = modelsDir();
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'page.gguf'), '<!doctype html>');
    } finally { if (prevHome === undefined) delete process.env.AAS_HOME; else process.env.AAS_HOME = prevHome; }
    const config = join(home, 'aas.config.json');
    await mkdir(home, { recursive: true });
    await writeFile(config, JSON.stringify({ runtime: { kind: 'inproc' } }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    assert.match(text, /page\.gguf は GGUF ではありません/);
  });
});

describe('外の道具（MCP）の支度を、doctor で見る', () => {
  test('合言葉が無ければ名前だけ言い、あっても値は出さない', async () => {
    const { home, models, config } = await scratch();
    await writeFile(config, JSON.stringify({
      runtime: { kind: 'inproc', modelsDir: models },
      mcp: { servers: { github: { command: process.execPath, args: ['-e', '0'], envFrom: { GITHUB_PERSONAL_ACCESS_TOKEN: 'AAS_TEST_TOKEN' } } } },
    }));
    const missing = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    assert.match(missing, /外の道具 \(github\)/);
    assert.match(missing, /合言葉が環境にありません: AAS_TEST_TOKEN/);
    const present = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config, AAS_TEST_TOKEN: 'ghp_SECRET_VALUE_1234567890' });
    assert.match(present, /合言葉 AAS_TEST_TOKEN あり/);
    assert.doesNotMatch(present, /ghp_SECRET/, '値が出ている');
  });
  test('置き場の .env から読めれば、あり になる', async () => {
    const { home, models, config } = await scratch();
    await mkdir(home, { recursive: true });
    await writeFile(join(home, '.env'), 'AAS_TEST_TOKEN2=ghp_FROM_FILE\n');
    await writeFile(config, JSON.stringify({
      runtime: { kind: 'inproc', modelsDir: models },
      mcp: { servers: { github: { command: process.execPath, envFrom: { GITHUB_PERSONAL_ACCESS_TOKEN: 'AAS_TEST_TOKEN2' } } } },
    }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    assert.match(text, /合言葉 AAS_TEST_TOKEN2 あり/);
    assert.doesNotMatch(text, /ghp_FROM_FILE/);
  });
});

/**
 * 置いてあることを、使えることとして言わない。
 *
 * `.gguf` という名前のファイルが在れば「1 件」と数えていた。中身が GGUF で
 * なくても、締めの一行は「動かせます」だった。**実際に送ると 503 で断られる。**
 * 起動できたことを使えることとして言う、といういつもの形を、こちら側でも
 * やっていた。置いてある数ではなく、**使える数**で決める。
 */
describe('読めないモデルしか無いとき', () => {
  test('「動かせます」と言わない', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { tempDir } = await import('./tmp.ts');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');

    const home = await tempDir('aas-badgguf-');
    await mkdir(join(home, 'models'), { recursive: true });
    // 名前だけ .gguf。中身は配布元の同意頁の HTML、という形がいちばん多い。
    await writeFile(join(home, 'models', 'nope.gguf'), '<!doctype html><html>同意してください</html>');

    const got = await new Promise<{ out: string }>((ok) => {
      execFile(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', join(root, 'src', 'cli', 'doctor.ts')],
        { env: { ...process.env, AAS_HOME: home }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
        (_e, stdout, stderr) => ok({ out: `${stdout}${stderr}` }),
      );
    });
    assert.match(got.out, /どれも GGUF として読めません/, `言っていない: ${got.out.slice(-600)}`);
    assert.ok(!/動かせます/.test(got.out), `動かせると言っている: ${got.out.slice(-600)}`);
  });
});

/**
 * 「在る」を「書ける」として言わない。
 *
 * 記録の保存先は、在るかどうかしか見ていなかった。読めるだけの場所
 * （読み取り専用で配られたフォルダ、権限の足りない `%ProgramData%`、
 * 会社のクラウドドライブ）でも ok と出る。**会話も、戻り先も、設定も、
 * 何ひとつ残らないのに緑が出る。**気づくのは、閉じて開き直して
 * 全部消えたとき。一度書いて、消して、確かめる。
 */
describe('記録の保存先へ書けないとき', () => {
  test('未了として出す', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { tempDir } = await import('./tmp.ts');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');

    const home = await tempDir('aas-nowrite-');
    /*
     * **権限で塞がない。**このテストを root で走らせると、読み取り専用の
     * フォルダにも書けてしまい、通ってしまう（実際にそうなった）。
     * 保存先と同じ名前のファイルを置いて、フォルダを作れなくする。
     * これなら誰で走らせても同じ。
     */
    const state = join(home, 'state');
    await writeFile(state, '');

    const got = await new Promise<{ out: string }>((ok) => {
      execFile(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', join(root, 'src', 'cli', 'doctor.ts')],
        {
          env: { ...process.env, AAS_HOME: home, AAS_STATE_DIR: state },
          encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
        },
        (_e, stdout, stderr) => ok({ out: `${stdout}${stderr}` }),
      );
    });
    assert.match(got.out, /へ書けません/, `言っていない: ${got.out.slice(-600)}`);
    assert.ok(!/動かせます/.test(got.out), `動かせると言っている: ${got.out.slice(-600)}`);
  });
});

/**
 * 黙って別の場所へ置かない。
 *
 * 利用者名が全角だと根も全角になる。モデルを読むところが全角の混ざった道から
 * ファイルを開けないので、**モデルだけ** ProgramData へ逃がしている。
 * その**逃がしていること自体が、どこにも出ていなかった。**使う側から見ると
 * モデルだけ置いたはずの場所と違う所に居て、理由が分からない。
 */
describe('根に全角が混ざっているとき', () => {
  test('モデルを逃がしたことを、言う', async () => {
    const { mkdir } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { execFile } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { tempDir } = await import('./tmp.ts');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');

    const base = await tempDir('aas-zenkaku-');
    const home = join(base, '全角の利用者');
    const programData = join(base, 'pd');
    await mkdir(home, { recursive: true });
    await mkdir(programData, { recursive: true });

    const run = (env: Record<string, string>) => new Promise<string>((ok) => {
      execFile(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', join(root, 'src', 'cli', 'doctor.ts')],
        { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
        (_e, stdout, stderr) => ok(`${stdout}${stderr}`),
      );
    });

    const said = await run({ AAS_HOME: home, ProgramData: programData });
    assert.match(said, /逃がしています/, `逃がしたことを言っていない: ${said.slice(-500)}`);
    assert.match(said, /全角/, '理由を言っていない');

    // **半角のときは出さない（対）。**いつも出ていると、出ていること自体が
    // 合図にならない。
    const plain = await run({ AAS_HOME: programData, ProgramData: programData });
    assert.ok(!/逃がしています/.test(plain), `半角なのに出ている: ${plain.slice(-300)}`);
  });
});
