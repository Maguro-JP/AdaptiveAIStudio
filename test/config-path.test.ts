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
});
