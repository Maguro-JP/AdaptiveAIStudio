/**
 * 画面から設定を変える口。
 *
 * cmd の窓でしかできないことを残さない、が狙い。ただし
 * **設定ファイル全部を書けるようにはしない**。設定という顔をして
 * 道具の振る舞いを丸ごと差し替えられる口になるため。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { UiServer } from '../src/ui/server.ts';
import {
  RUNTIME_KINDS, inspectModelsDir, DIR_NOTES, ensureDefaultModelsDir, savedModelsDir, saveRuntime, readSavedRuntime,
} from '../src/ui/settings.ts';
import { loadConfig } from '../src/config.ts';
import { installRoot } from '../src/core/home.ts';

const servers: UiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

async function start(): Promise<{ url: string; at: string; models: string }> {
  const dir = await tempDir('aas-cfg-');
  const models = join(dir, 'models');
  await mkdir(models, { recursive: true });
  await writeFile(join(models, 'qwen2.5-3b-instruct-q4_k_m.gguf'), 'GGUF');
  const at = join(dir, 'aas.config.json');
  process.env.AAS_CONFIG = at;
  process.env.AAS_HOME = join(dir, 'home');
  const s = new UiServer({ config: loadConfig().config, port: 0 });
  servers.push(s);
  return { url: await s.start(), at, models };
}

describe('設定の口', () => {
  test('いまの設定と、置いてある GGUF が読める', async () => {
    const { url, models } = await start();
    const r = await fetch(new URL('/api/config', url)).then((x) => x.json()) as {
      kinds: { id: string }[]; kind: string; gguf: { ref: string }[]; modelsDir: string;
    };
    assert.deepEqual(r.kinds.map((k) => k.id), [...RUNTIME_KINDS]);
    assert.equal(r.kind, 'inproc'); // 設定が無いときの既定
    // 置き場を指していなくても、既定の置き場を答える（空にしない）。
    assert.ok(r.modelsDir.length > 0);
    void models;
  });

  test('決めたものだけを書き換える', async () => {
    const { url, at, models } = await start();
    const r = await fetch(new URL('/api/config', url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'inproc', modelsDir: models }),
    });
    assert.equal(r.status, 200);
    const saved = JSON.parse(await readFile(at, 'utf8')) as { runtime: Record<string, string> };
    assert.equal(saved.runtime.kind, 'inproc');
    assert.equal(saved.runtime.modelsDir, models);

    // 書いたものが読み返せること。**保存した直後に古い値を見せない。**
    const after = await fetch(new URL('/api/config', url)).then((x) => x.json()) as {
      kind: string; gguf: { ref: string }[]; restartNeeded: boolean; active: { kind: string };
    };
    assert.equal(after.kind, 'inproc');
    assert.deepEqual(after.gguf.map((g) => g.ref), ['qwen2.5-3b-instruct-q4_k_m.gguf']);
    // いま動いているものは別。黙って効いた顔をしない。
    assert.equal(after.active.kind, 'inproc'); // 設定が無いときの既定で動いている
    assert.equal(after.restartNeeded, true); // 置き場が変わる
  });

  test('知らない動かし方は受け取らない', async () => {
    const { url } = await start();
    const r = await fetch(new URL('/api/config', url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'なんでも実行する' }),
    });
    assert.equal(r.status, 400);
  });

  test('画面から見えない設定を消さない', async () => {
    const { url, at } = await start();
    // 画面に無い設定が既にある状態にする。
    await writeFile(at, JSON.stringify({
      system: 'これは残らなければならない',
      runtime: { kind: 'ollama', desiredContext: 8192 },
    }), 'utf8');
    await fetch(new URL('/api/config', url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'inproc' }),
    });
    const saved = JSON.parse(await readFile(at, 'utf8')) as {
      system: string; runtime: { kind: string; desiredContext: number };
    };
    assert.equal(saved.system, 'これは残らなければならない');
    assert.equal(saved.runtime.desiredContext, 8192, '画面に無い設定を消した');
    assert.equal(saved.runtime.kind, 'inproc');
  });
});

describe('モデルが無いまま送らせない', () => {
  test('待たせずに、理由と次の一手を返す', async () => {
    // 黙って待つと、画面は「考え中」のまま止まる。繋ぎ先の応答待ちは
    // 数十秒になることがあり、その間ずっと固まったように見える。
    const { url } = await start();
    const r = await fetch(new URL('/api/send', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'こんにちは' }),
    });
    assert.equal(r.status, 503);
    const body = await r.json() as { error: string };
    assert.match(body.error, /GGUF がありません|モデルがまだありません/);
    assert.match(body.error, /設定 → モデル/, '次の一手が書かれていない');
  });

  test('改行を潰さない', async () => {
    // 次の一手を数行で書くので、一行に潰れると読めない。
    const { readFile } = await import('node:fs/promises');
    const css = await readFile(join(installRoot(), 'src', 'ui', 'web', 'style.css'), 'utf8');
    assert.match(css, /\.note \{[^}]*white-space: pre-line/);
  });
});

describe('置き場を、保存する前に見る', () => {
  test('在るフォルダは OK', async () => {
    const dir = await tempDir('aas-dir-');
    assert.equal(await inspectModelsDir(dir), 'OK');
  });

  test('空文字は「既定を使う」であって、間違いではない', async () => {
    assert.equal(await inspectModelsDir(''), 'OK');
  });

  test('無い置き場は MISSING（拒まずに言う）', async () => {
    const dir = join(await tempDir('aas-dir-'), 'まだない');
    assert.equal(await inspectModelsDir(dir), 'MISSING');
  });

  test('ファイルを指したら NOT_A_DIR', async () => {
    const file = join(await tempDir('aas-dir-'), 'a.gguf');
    await writeFile(file, 'x');
    assert.equal(await inspectModelsDir(file), 'NOT_A_DIR');
  });

  test('どの符丁にも、人へ見せる文がある', () => {
    // 符丁を足して DIR_NOTES に書き忘れると、画面が黙る。
    for (const s of ['OK', 'MISSING', 'NOT_A_DIR', 'UNREADABLE'] as const) {
      assert.equal(typeof DIR_NOTES[s], 'string');
      if (s !== 'OK') assert.ok(DIR_NOTES[s].length > 0, `文が無い: ${s}`);
    }
  });

  test('画面の側にも、同じ符丁が同じ文で置いてある', async () => {
    // 基幹は符丁のまま。日本語は表示のときだけ。両方に置いた以上、ずれる。
    const app = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '../src/ui/web/app.js'), 'utf8');
    for (const [sign, note] of Object.entries(DIR_NOTES)) {
      if (!note) continue;
      assert.ok(app.includes(`${sign}: '${note}'`), `画面に無いか、文が違う: ${sign}`);
    }
  });
});

describe('既定の置き場は、無ければ作る', () => {
  test('作って OK を返す', async () => {
    const dir = join(await tempDir('aas-mk-'), 'models');
    assert.equal(await inspectModelsDir(dir), 'MISSING');
    assert.equal(await ensureDefaultModelsDir(dir), 'OK');
    assert.equal(await inspectModelsDir(dir), 'OK');
  });

  test('既に在れば、そのまま OK', async () => {
    const dir = await tempDir('aas-mk-');
    assert.equal(await ensureDefaultModelsDir(dir), 'OK');
  });

  test('作れなければ、止めずに理由を返す', async () => {
    // ファイルの下にフォルダは作れない。
    const file = join(await tempDir('aas-mk-'), 'a.txt');
    await writeFile(file, 'x');
    assert.equal(await ensureDefaultModelsDir(join(file, 'models')), 'NOT_A_DIR');
  });
});

describe('見せる置き場と、落とす置き場は同じ', () => {
  // configPath は AAS_CONFIG があればそれを使う（この検査の上のほうで立てている）。
  // cwd ではなく、そちらを差し替える。
  async function withConfig<T>(run: (root: string) => Promise<T>): Promise<T> {
    const root = await tempDir('aas-saved-');
    const prev = process.env.AAS_CONFIG;
    process.env.AAS_CONFIG = join(root, 'aas.config.json');
    try { return await run(root); } finally {
      if (prev === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = prev;
    }
  }

  test('保存してあれば、それ', async () => {
    await withConfig(async (root) => {
      const dir = join(root, 'ここ');
      await saveRuntime('inproc', dir);
      assert.equal(await savedModelsDir(), dir);
    });
  });

  test('保存が無ければ、既定（対）', async () => {
    await withConfig(async () => {
      const { modelsDir } = await import('../src/core/home.ts');
      assert.equal(await savedModelsDir(), modelsDir());
    });
  });
});

describe('使う GGUF を決める', () => {
  test('保存して、読み出しに出る。空文字で消える', async () => {
    const root = await tempDir('aas-model-');
    const prev = process.env.AAS_CONFIG;
    process.env.AAS_CONFIG = join(root, 'aas.config.json');
    try {
      await saveRuntime('inproc', '', 'b.gguf');
      assert.equal((await readSavedRuntime()).model, 'b.gguf');
      await saveRuntime('inproc', '');           // 触らない
      assert.equal((await readSavedRuntime()).model, 'b.gguf');
      await saveRuntime('inproc', '', '');       // 消す
      assert.equal((await readSavedRuntime()).model, undefined);
    } finally {
      if (prev === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = prev;
    }
  });
});

/**
 * 送られてこなかった項目は、触らない。
 *
 * 横の「フォルダを変える」は作業場だけを変えるつもりで、`kind` と `modelsDir` も
 * 一緒に送っていた。値は設定の頁の入力欄から取るが、その欄は設定→モデルを
 * 開いたときしか埋まらない。開いていない頁では空なので、空の `kind` は inproc に、
 * 空の `modelsDir` は「消す」と読まれる。**llamacpp や Ollama を選び、置き場所を
 * 別のドライブへ向けていた人が、作業場を変えただけでそれを失う。**
 * 画面は何も言わないので、立ち上げ直したあとに「モデルが無い」で気づく。
 */
describe('作業場だけを変えたときに、動かし方を消さない', () => {
  test('**workRoot だけ送れば、動かし方と保存先は残る**', async () => {
    const { url, at, models } = await start();
    const work = await tempDir('aas-cfg-work-');
    // 設定→モデルで、この中で読む道ではないものを選んだ状態を作る。
    const saved = await fetch(new URL('/api/config', url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'llamacpp', modelsDir: models }),
    });
    assert.equal(saved.status, 200);

    const r = await fetch(new URL('/api/config', url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workRoot: work }),
    });
    assert.equal(r.status, 200, await r.text());

    const after = JSON.parse(await readFile(at, 'utf8')) as {
      runtime?: { kind?: string; modelsDir?: string }; agent?: { root?: string };
    };
    assert.equal(after.runtime?.kind, 'llamacpp', `動かし方が戻っている: ${JSON.stringify(after.runtime)}`);
    assert.equal(after.runtime?.modelsDir, models, `保存先が消えている: ${JSON.stringify(after.runtime)}`);
    assert.equal(after.agent?.root, work, '作業場が変わっていない');
  });

  test('**書いていないものを「保存した」と言わない**', async () => {
    const { url } = await start();
    const work = await tempDir('aas-cfg-work2-');
    const body = await fetch(new URL('/api/config', url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workRoot: work }),
    }).then((x) => x.json()) as { saved?: unknown };
    assert.equal(body.saved, undefined, `書いていないのに saved を返している: ${JSON.stringify(body.saved)}`);
  });

  test('何も指さない保存は、断る', async () => {
    const { url } = await start();
    const r = await fetch(new URL('/api/config', url), {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 400);
  });

  test('動かし方を送ったときは、これまでどおり書く（対）', async () => {
    const { url, at, models } = await start();
    const r = await fetch(new URL('/api/config', url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'ollama', modelsDir: models }),
    });
    assert.equal(r.status, 200, await r.text());
    const after = JSON.parse(await readFile(at, 'utf8')) as { runtime?: { kind?: string } };
    assert.equal(after.runtime?.kind, 'ollama');
  });
});

/**
 * 画面の側も、触らないものを送らない。
 *
 * 本体を直しても、画面が空の `kind` を送り続ければ同じことが起きる
 * （`kind` が来た以上、本体は「変えたい」と読む）。**両方で塞ぐ。**
 */
describe('フォルダを変えるつまみは、作業場だけを送る', () => {
  test('**pickWorkRoot が送るのは workRoot だけ**', async () => {
    const app = await readFile(join(installRoot(), 'src', 'ui', 'web', 'app.js'), 'utf8');
    const at = app.indexOf('async function pickWorkRoot');
    assert.ok(at > 0, 'pickWorkRoot が見つからない');
    const body = app.slice(at, app.indexOf('\n}', at));
    assert.doesNotMatch(body, /cfgKind|cfgModelsDir/,
      `作業場を変えるだけなのに、動かし方まで送っている:\n${body}`);
  });
});
