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
    env: { ...process.env, ...env, NO_COLOR: '1' },
    timeout: 120_000,
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
  test('土台が無いときの案内に、実行ファイルの増えない道が出る', async () => {
    const { home } = await scratch();
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: join(home, 'なし.json') });
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
    assert.match(text, /動かせます。/);
  });

  test('繋ぎ先を、外へ見に行かない', async () => {
    // 口はこのプログラムの中に立つ。外から見に行っても、モデルを読むまで
    // 立たないので必ず「繋がりません」になる。**それは不足ではない。**
    const { home, models, config } = await scratch();
    await writeFile(join(models, 'm.gguf'), 'GGUF');
    await writeFile(config, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: models } }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    // 札が設定の id（ollama）のままだと「Ollama を入れなければ」と読まれる。
    assert.match(text, /接続 \(この中で読む\)/);
    assert.doesNotMatch(text, /接続 \(ollama\)/);
    assert.match(text, /この中に立てます/);
    assert.doesNotMatch(text, /件かたづければ動きます/);
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
      mcp: { servers: { github: { command: 'npx', args: ['-y', 'x'], envFrom: { GITHUB_PERSONAL_ACCESS_TOKEN: 'AAS_TEST_TOKEN' } } } },
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
      mcp: { servers: { github: { command: 'npx', envFrom: { GITHUB_PERSONAL_ACCESS_TOKEN: 'AAS_TEST_TOKEN2' } } } },
    }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    assert.match(text, /合言葉 AAS_TEST_TOKEN2 あり/);
    assert.doesNotMatch(text, /ghp_FROM_FILE/);
  });
});
