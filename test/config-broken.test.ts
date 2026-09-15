/**
 * 設定が壊れているときに、直しに行く手段まで塞がない。
 *
 * `aas.config.json` は手で書ける。末尾のコンマや閉じ忘れは普通に起きる。
 * そのとき出ていたのは Node のスタックだけだった。
 *
 *   SyntaxError: Expected double-quoted property name in JSON at position 33
 *     at JSON.parse (<anonymous>) ...
 *
 * どのファイルの話かも書いていない。しかも落ちるのは設定を読むところなので、
 * **`doctor`（困ったときに見るもの）も、画面も、同じ所で死ぬ。**
 * 「モデルが一つ無いだけで画面じゅうが 500 になる」と同じ形。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfigText, ConfigBroken, loadConfig } from '../src/config.ts';
import { tempDir } from './tmp.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('壊れた設定', () => {
  test('どのファイルの、何行目かを言う', () => {
    const broken = '{\n  "runtime": { "kind": "inproc" },\n  "temperature": 0.2,\n}\n';
    try {
      parseConfigText(broken, '/どこか/aas.config.json');
      assert.fail('落ちていない');
    } catch (e) {
      assert.ok(e instanceof ConfigBroken, `別のもので落ちた: ${String(e)}`);
      const said = (e as Error).message;
      assert.match(said, /どこか\/aas\.config\.json/, 'ファイルを言っていない');
      assert.match(said, /4 行目/, `行を言っていない: ${said}`);
      // 次の一手。**消せば動く**ことまで言う。
      assert.match(said, /消せば/, '次の一手が無い');
    }
  });

  test('壊れていなければ、そのまま読む（対）', () => {
    const got = parseConfigText('{"temperature": 0.5}', '/どこか/aas.config.json');
    assert.equal(got.temperature, 0.5);
  });

  test('doctor は、スタックではなく理由を出して終わる', async () => {
    const home = await tempDir('aas-broken-');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'aas.config.json'), '{ "runtime": { "kind": "inproc", }, }');
    const got = await new Promise<{ code: number | null; out: string }>((ok) => {
      execFile(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', join(root, 'src', 'cli', 'doctor.ts')],
        { env: { ...process.env, AAS_HOME: home, AAS_REPORT_DIR: home }, encoding: 'utf8' },
        (err, stdout, stderr) => ok({
          code: (err as { code?: number } | null)?.code ?? 0,
          out: `${stdout}${stderr}`,
        }),
      );
    });
    assert.equal(got.code, 1, `終了コードが違う: ${got.out.slice(0, 300)}`);
    assert.match(got.out, /設定を読めません/, `理由が出ていない: ${got.out.slice(0, 300)}`);
    // **スタックを見せない。**読む人には何も分からず、次の一手も出てこない。
    assert.ok(!/at JSON\.parse|node:internal/.test(got.out), `スタックが出ている: ${got.out.slice(0, 400)}`);
  });
});

describe('動かし方を書いていないとき', () => {
  /**
   * 設定ファイルが無ければ「この中で読む（inproc）」が既定。ところが、
   * ファイルは在るのに `runtime` を書いていないときだけ Ollama 扱いに
   * なっていた。**同じ「書いていない」なのに、ファイルの有無で行き先が
   * 変わる。**Ollama を入れていない機械では、モデルを取ってくる所も
   * `ollama pull` へ行き、必ず「繋がりません」で終わる。
   */
  test('設定はあるが runtime が無いとき、この中で読む', async () => {
    const dir = await tempDir('aas-cfg-kind-');
    await writeFile(join(dir, 'aas.config.json'), JSON.stringify({ temperature: 0.3 }), 'utf8');
    const { config } = loadConfig(dir);
    assert.equal(config.runtime?.kind, 'inproc', '書いていないのに Ollama になっている');
  });

  test('書いてあるものは、そのまま使う', async () => {
    const dir = await tempDir('aas-cfg-kind2-');
    await writeFile(join(dir, 'aas.config.json'),
      JSON.stringify({ runtime: { kind: 'ollama' } }), 'utf8');
    assert.equal(loadConfig(dir).config.runtime?.kind, 'ollama');
  });
});
