/**
 * 設定ファイルの場所と、無いときの既定。
 *
 * 製品の形（portable・インストール）では、起動時の場所は app\ で、そこに設定は無い。
 * 画面から保存すると app\ に書いていた。インストール先は書けず、portable でも更新で消える。
 * さらに設定が無いと Ollama が既定で、GGUF を置いても「Provider が起動しているか」で止まっていた。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { configPath, loadConfig } from '../src/config.ts';
import { INPROC_PORT } from '../src/runtime/inproc.ts';

const saved = { AAS_CONFIG: process.env.AAS_CONFIG, AAS_HOME: process.env.AAS_HOME };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('設定の場所', () => {
  test('隣に無ければ、データの置き場（AAS_HOME）を見る', async () => {
    const cwd = await tempDir('aas-app-');
    const home = await tempDir('aas-home-');
    delete process.env.AAS_CONFIG;
    process.env.AAS_HOME = home;
    assert.equal(configPath(cwd), join(home, 'aas.config.json'));
  });

  test('隣に在れば、それを先に見る（開発の場所）', async () => {
    const cwd = await tempDir('aas-app-');
    const home = await tempDir('aas-home-');
    await writeFile(join(cwd, 'aas.config.json'), '{}');
    delete process.env.AAS_CONFIG;
    process.env.AAS_HOME = home;
    assert.equal(configPath(cwd), join(cwd, 'aas.config.json'));
  });

  test('AAS_CONFIG が最優先', async () => {
    const cwd = await tempDir('aas-app-');
    process.env.AAS_CONFIG = join(cwd, 'x.json');
    assert.equal(configPath(cwd), join(cwd, 'x.json'));
  });

  test('設定が無ければ、この中で読む（inproc）が既定で、繋ぎ先も埋まる', async () => {
    const cwd = await tempDir('aas-app-');
    const home = await tempDir('aas-home-');
    delete process.env.AAS_CONFIG;
    process.env.AAS_HOME = home;
    const { config, source } = loadConfig(cwd);
    assert.equal(config.runtime?.kind, 'inproc');
    const local = config.providers.find((p) => p.kind === 'openai-compatible' && p.locality === 'local');
    assert.equal(local?.baseUrl, `http://127.0.0.1:${INPROC_PORT}/v1`);
    assert.ok(source.includes('なし'), source); // doctor はこの語で「無い」を見分ける
    assert.ok(source.includes(join(home, 'aas.config.json')), source); // 書く先を言う
  });

  /**
   * ここは URL だけ書き換えて、名前（`ollama`）をそのままにしていた。
   * **中身は inproc なのに名前は ollama** なので、モデルの名前が
   * `ollama:...` になり、失敗すると「ollama への接続に失敗しました」と出る。
   * Ollama を使っていない人が、Ollama を疑うことになる。
   */
  test('**この中で読むときは、名前も inproc にする**', async () => {
    const cwd = await tempDir('aas-name-');
    const home = await tempDir('aas-home2-');
    delete process.env.AAS_CONFIG;
    process.env.AAS_HOME = home;
    const { config } = loadConfig(cwd);
    const local = config.providers.find((p) => p.kind === 'openai-compatible' && p.locality === 'local');
    assert.equal(local?.id, 'inproc', 'Ollama を使っていないのに ollama と名乗っている');
    assert.ok(!config.providers.some((p) => p.id === 'ollama'),
      'ollama という名前が残っている');
  });

  /**
   * `listModels()` は一覧が取れないとき、**設定に書いてある名前で続行する。**
   * 既定の項目には Ollama 向けの名前（`qwen3.5:9b` など）が書いてあるので、
   * 口がまだ立っていない一瞬にそれが起きると、実在しないモデルが候補になり、
   * 送るたびに繋がらない相手を叩き続けることになる。
   */
  test('**Ollama 向けのモデル名を持ち越さない**', async () => {
    const cwd = await tempDir('aas-models-');
    const home = await tempDir('aas-home4-');
    delete process.env.AAS_CONFIG;
    process.env.AAS_HOME = home;
    const { config } = loadConfig(cwd);
    const local = config.providers.find((p) => p.kind === 'openai-compatible' && p.locality === 'local');
    assert.equal(local?.models, undefined,
      `この中で読む道に、Ollama の名前が残っている: ${JSON.stringify(local?.models)}`);
  });

  test('自分で名前を付けているなら、触らない（対）', async () => {
    const cwd = await tempDir('aas-keep-');
    const home = await tempDir('aas-home3-');
    process.env.AAS_HOME = home;
    const at = join(home, 'aas.config.json');
    await writeFile(at, JSON.stringify({
      runtime: { kind: 'inproc' },
      providers: [{ id: 'わたしの土台', kind: 'openai-compatible', locality: 'local', baseUrl: 'http://x/v1' }],
    }));
    process.env.AAS_CONFIG = at;
    const { config } = loadConfig(cwd);
    const local = config.providers.find((p) => p.kind === 'openai-compatible' && p.locality === 'local');
    assert.equal(local?.id, 'わたしの土台', '利用者が付けた名前を書き換えている');
    assert.equal(local?.baseUrl, `http://127.0.0.1:${INPROC_PORT}/v1`, '繋ぎ先は埋める');
  });
});
