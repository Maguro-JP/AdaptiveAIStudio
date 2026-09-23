/**
 * **保存した設定を、無かったことにしない。**
 *
 * 開いた時点の道案内（`/api/ready`）は、**いま動いている**保存先だけを見て
 * 理由を書いていた。設定 → モデル で保存先を入れて保存した直後（立ち上げ直す
 * 前）は、保存した方に GGUF が在っても「（古い保存先）に GGUF がありません」と
 * 出る。**置いた人は、置いたはずのものを疑いに行く。**
 *
 * 配る先で最初にやる操作がこれなので、ここで嘘をつくと、その先へ進めない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-ready-saved-state-');
process.env.AAS_HOME = await tempDir('aas-ready-saved-home-');
const cfgPath = join(await tempDir('aas-ready-saved-cfg-'), 'aas.config.json');
process.env.AAS_CONFIG = cfgPath;

const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

/** いま動いている保存先（live）と、設定ファイルに保存した保存先（saved）で訊く。 */
async function why(live: string, saved: { kind?: string; modelsDir?: string }): Promise<string> {
  await writeFile(cfgPath, JSON.stringify({ runtime: saved }), 'utf8');
  const srv = new UiServer({
    port: 0,
    config: { ...DEFAULT_CONFIG, runtime: { kind: 'inproc', modelsDir: live } } as typeof DEFAULT_CONFIG,
  });
  const base = (await srv.start()).replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/api/ready`);
    const body = await r.json() as { ready: boolean; why: string };
    assert.equal(body.ready, false, 'モデルが無いのに話せることになっている');
    return body.why;
  } finally {
    await srv.stop();
  }
}

describe('保存した設定と、いま動いているものが違うとき', () => {
  test('**立ち上げ直せば使えることを言う（保存した保存先に GGUF が在る）**', async () => {
    const live = await tempDir('aas-ready-live-');
    const kept = await tempDir('aas-ready-kept-');
    await writeFile(join(kept, 'tiny.gguf'), 'GGUF ではないが、名前は .gguf');
    const said = await why(live, { kind: 'inproc', modelsDir: kept });
    assert.match(said, /立ち上げ直す/, `立ち上げ直せば使えることを言っていない: ${said}`);
    assert.ok(said.includes(kept), `保存した保存先を出していない: ${said}`);
    assert.doesNotMatch(said, new RegExp(`${live.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} に GGUF がありません`),
      `保存した方を見ずに、古い保存先で「ありません」と言っている: ${said}`);
  });

  test('保存した保存先にも無いなら、そこへ置くように言う', async () => {
    const live = await tempDir('aas-ready-live2-');
    const kept = await tempDir('aas-ready-kept2-');
    const said = await why(live, { kind: 'inproc', modelsDir: kept });
    assert.ok(said.includes(kept), `保存した保存先を出していない: ${said}`);
    assert.match(said, /\.gguf を1つ置いて/, said);
  });

  test('食い違っていなければ、これまでどおり保存先を出す（対）', async () => {
    const live = await tempDir('aas-ready-same-');
    const said = await why(live, { kind: 'inproc', modelsDir: live });
    assert.ok(said.includes(live), `保存先を出していない: ${said}`);
    assert.doesNotMatch(said, /立ち上げ直す/, `食い違っていないのに立ち上げ直せと言っている: ${said}`);
  });
});
