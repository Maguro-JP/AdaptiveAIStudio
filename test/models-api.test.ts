/**
 * 画面がモデルを描くための答え（`GET /api/models`）。
 *
 * パネルの側だけ見ても足りない。パネルのテストは偽の答えを渡して描くので、
 * **サーバーが本当にその値を返しているか**は見ていない。ここで繋ぎ目を見る。
 *
 * 見るのは一つ。Ollama で動かしているときも、保存先にある .gguf の件数を返すこと。
 * Ollama のときの一覧は Ollama に入っているモデルなので、保存先に自分で置いた
 * .gguf は一つも出ない。件数が返っていないと、画面は「まだありません」とだけ
 * 言うしかなく、落として置いた人には何が起きているのか分からない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-models-api-state-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

/** .gguf を二つと、関係ないファイルを一つ置いた保存先。 */
async function place() {
  const dir = await tempDir('aas-models-api-');
  await writeFile(join(dir, 'a.gguf'), '');
  await writeFile(join(dir, 'b.gguf'), '');
  await writeFile(join(dir, 'notes.txt'), 'これは数えない');
  return dir;
}

async function ask(kind: 'ollama' | 'inproc', modelsDir: string) {
  const server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [],
      candidates: [],
      runtime: { kind, modelsDir },
      agent: { root: modelsDir, approval: 'auto' },
      initiative: { enabled: false },
    } as never,
  });
  const base = (await server.start()).replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/models`);
    // 中身は一度しか読めない。先に読んでから見る（`assert` の言葉に渡すと、そこで読み切る）。
    const said = await res.text();
    assert.equal(res.status, 200, said);
    return JSON.parse(said) as { runtime: string; localGguf: number; installed: { ref: string }[]; modelsDir: string };
  } finally { await server.stop(); }
}

describe('保存先にある .gguf の件数を返す', () => {
  test('**Ollama のときも、件数を返す**', async () => {
    const dir = await place();
    const got = await ask('ollama', dir);
    assert.equal(got.runtime, 'ollama');
    // ここで Ollama は動いていないので、一覧は空。**在るのに何も言えない形**がこれ。
    assert.deepEqual(got.installed, []);
    assert.equal(got.localGguf, 2, `保存先の .gguf を数えていない: ${JSON.stringify(got)}`);
    assert.equal(got.modelsDir, dir);
  });

  test('中で読むときは 0（一覧そのものに出るので、二重に言わない）', async () => {
    const dir = await place();
    const got = await ask('inproc', dir);
    assert.deepEqual(got.installed.map((m) => m.ref), ['a.gguf', 'b.gguf']);
    assert.equal(got.localGguf, 0, `一覧に出ているものを、二度数えている: ${JSON.stringify(got)}`);
  });

  test('保存先が無いときは 0（読めなくても落ちない）', async () => {
    const got = await ask('ollama', join(await tempDir('aas-models-api-none-'), 'ない'));
    assert.equal(got.localGguf, 0);
  });
});
