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
  return `${out.stdout ?? ''}${out.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
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
    await writeFile(join(models, 'qwen2.5-3b-instruct-q4_k_m.gguf'), 'x');
    await writeFile(config, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: models } }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    assert.match(text, /1 件: qwen2\.5-3b-instruct-q4_k_m\.gguf/);
    assert.match(text, /動かせます。/);
  });

  test('使っていない Ollama を、不足として数えない', async () => {
    // 使っていないものが繋がらないのは問題ではない。
    // 未了に数えると「かたづける件数」が嘘になる。
    const { home, models, config } = await scratch();
    await writeFile(join(models, 'm.gguf'), 'x');
    await writeFile(config, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: models } }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config });
    assert.match(text, /繋がりません（使っていません）/);
    assert.doesNotMatch(text, /件かたづければ動きます/);
  });
});
