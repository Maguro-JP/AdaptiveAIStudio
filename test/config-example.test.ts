/**
 * 見本の設定が、そのまま使えること。
 *
 * doctor は「変えたくなったら cp aas.config.example.json aas.config.json」と
 * 言う。写した見本が読めない・土台が書いていない、では案内になっていない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { installRoot } from '../src/core/home.ts';
import { loadConfig } from '../src/config.ts';
import { isRuntimeKind } from '../src/ui/settings.ts';

async function withConfig<T>(path: string, run: () => Promise<T>): Promise<T> {
  const prev = process.env.AAS_CONFIG;
  process.env.AAS_CONFIG = path;
  try { return await run(); } finally {
    if (prev === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = prev;
  }
}

describe('見本の設定', () => {
  test('そのまま読めて、土台が決まっている', async () => {
    await withConfig(join(installRoot(), 'aas.config.example.json'), async () => {
      const { config } = loadConfig();
      assert.ok(isRuntimeKind(config.runtime?.kind), `土台が無い: ${String(config.runtime?.kind)}`);
      assert.equal(config.runtime?.modelsDir, undefined, '見本に置き場を決め打ちしない');
      // 候補を決め打ちすると、inproc では Ollama の札（qwen3.5:9b）が GGUF と
      // 合わず、毎回「無いので別ので答えます」と言う。既定（未指定）に任せる。
      assert.equal(config.candidates, undefined, '見本に候補を決め打ちしない');
      // README は「クラウドは既定で無効」と言う。写した見本でも無効でないと、鍵の無い警告が出る（DECISIONS 10-11、119 回目）
      for (const p of config.providers ?? []) {
        if ((p as { locality?: string }).locality === 'cloud') assert.equal((p as { enabled?: boolean }).enabled, false, `見本のクラウドの項目が有効: ${(p as { id: string }).id}`);
      }
    });
  });

  test('置き場が空欄なら、無いものとして扱う', async () => {
    const dir = await tempDir('aas-cfg-');
    const at = join(dir, 'aas.config.json');
    await writeFile(at, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: '   ' } }));
    await withConfig(at, async () => {
      assert.equal(loadConfig().config.runtime?.modelsDir, undefined);
    });
  });

  test('置き場が書いてあれば、そのまま（対）', async () => {
    const dir = await tempDir('aas-cfg-');
    const at = join(dir, 'aas.config.json');
    await writeFile(at, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: 'Z:\\models' } }));
    await withConfig(at, async () => {
      assert.equal(loadConfig().config.runtime?.modelsDir, 'Z:\\models');
    });
  });
});
