/**
 * 拡張機能の入れ物（src/extensions/registry.ts。docs/EXTENSIONS.md）。
 *
 * - 一覧は固定。パネルの種類は、画面の種類の一覧に在り、API の接頭辞とデータのフォルダは重ならない
 * - 入り切りは設定の `extensions.<id>.enabled`。書いていなければ既定（アイデアは入り）
 * - 切ると、その API は 404 を返し、パネルの種類が一覧から消える。入れ直すと、データが戻っている
 * - LAN の口（スマホ）には、拡張機能の API を出さない
 * - 片づけ（clean）は、切ってある拡張機能のデータだけを挙げる
 * - 外からコードや CSS を読み込む経路が無い
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

// 設定とデータを、試験専用の場所へ移してから本体を読み込む
const HOME = await tempDir('aas-ext-home-');
process.env.AAS_STATE_DIR = HOME;
process.env.AAS_CONFIG = join(HOME, 'aas.config.json');
await writeFile(process.env.AAS_CONFIG, '{}');
const { UiServer } = await import('../src/ui/server.ts');
const {
  EXTENSIONS, extensionById, extensionDataDir, extensionEnabled, extensionForPath, listExtensions, offPanelKinds,
} = await import('../src/extensions/registry.ts');
const { PANEL_KINDS } = await import('../src/ui/layout.ts');
const { saveExtensionEnabled } = await import('../src/ui/settings.ts');
const { findRemovable, remove } = await import('../src/runtime/cleanup.ts');

describe('一覧と入り切り', () => {
  test('一覧は固定で、id・パネルの種類・API の接頭辞・データのフォルダが重ならない。パネルの種類は、画面の種類の一覧に在る', () => {
    assert.deepEqual(EXTENSIONS.map((e) => e.id), ['ideas']);
    for (const key of ['id', 'panel', 'apiPrefix', 'dataDir'] as const) {
      assert.equal(new Set(EXTENSIONS.map((e) => e[key])).size, EXTENSIONS.length, key);
    }
    for (const e of EXTENSIONS) {
      assert.match(e.id, /^[a-z][a-z0-9-]*$/);
      assert.match(e.apiPrefix, /^\/api\/[a-z][a-z0-9-]*$/);
      assert.match(e.dataDir, /^[a-z][a-z0-9-]*$/, 'データのフォルダの名前で、上の階へ出られる');
      assert.ok((PANEL_KINDS as readonly string[]).includes(e.panel), `${e.panel} が画面の種類の一覧に無い`);
      assert.ok(e.name && e.description);
    }
  });

  test('書いていなければ既定（アイデアは入り）。真偽で書いてあれば、その値。一覧に無い id は入っていない', () => {
    assert.equal(extensionEnabled(undefined, 'ideas'), true);
    assert.equal(extensionEnabled({}, 'ideas'), true);
    assert.equal(extensionEnabled({ extensions: { ideas: {} } }, 'ideas'), true);
    assert.equal(extensionEnabled({ extensions: { ideas: { enabled: false } } }, 'ideas'), false);
    assert.equal(extensionEnabled({ extensions: { ideas: { enabled: 'no' as never } } }, 'ideas'), true, '真偽でない値で切れた');
    assert.equal(extensionEnabled({ extensions: { other: { enabled: true } } }, 'other'), false);
    assert.deepEqual(offPanelKinds({}), []);
    assert.deepEqual(offPanelKinds({ extensions: { ideas: { enabled: false } } }), ['ideas']);
    assert.deepEqual(listExtensions({ extensions: { ideas: { enabled: false } } }).map((e) => [e.id, e.enabled]), [['ideas', false]]);
  });

  test('道から拡張機能を引く。接頭辞そのものと、その下だけ（似た名前の道は違う）', () => {
    assert.equal(extensionForPath('/api/ideas')?.id, 'ideas');
    assert.equal(extensionForPath('/api/ideas/receive')?.id, 'ideas');
    assert.equal(extensionForPath('/api/ideasx'), undefined);
    assert.equal(extensionForPath('/api/extensions'), undefined);
    assert.equal(extensionById('nope'), undefined);
    assert.equal(extensionDataDir('ideas'), join(HOME, 'extensions', 'ideas'));
    assert.throws(() => extensionDataDir('nope'), /知らない拡張機能/);
  });

  test('入り切りを設定に書く。その拡張機能のほかの設定と、ほかの設定は残す', async () => {
    await writeFile(process.env.AAS_CONFIG!, JSON.stringify({ location: '大阪', extensions: { ideas: { note: 'x' }, later: { enabled: true } } }));
    await saveExtensionEnabled('ideas', false);
    assert.deepEqual(JSON.parse(await readFile(process.env.AAS_CONFIG!, 'utf8')), {
      location: '大阪', extensions: { ideas: { note: 'x', enabled: false }, later: { enabled: true } },
    });
    await saveExtensionEnabled('ideas', true);
    assert.equal(JSON.parse(await readFile(process.env.AAS_CONFIG!, 'utf8')).extensions.ideas.enabled, true);
    await writeFile(process.env.AAS_CONFIG!, '{}');
  });

  test('外からコードや CSS を読み込む経路が無い（一覧の項目に、読み込む先を書く欄が無い）', async () => {
    const text = await readFile(join(import.meta.dirname, '..', 'src', 'extensions', 'registry.ts'), 'utf8');
    assert.doesNotMatch(text, /import\(|require\(|\.css|<script|url:/i);
    assert.deepEqual(Object.keys(EXTENSIONS[0]!).sort(), ['apiPrefix', 'dataDir', 'defaultEnabled', 'description', 'id', 'name', 'panel']);
  });
});

describe('本体の口', () => {
  async function withServer<T>(config: Record<string, unknown>, body: (base: string, server: InstanceType<typeof UiServer>) => Promise<T>): Promise<T> {
    const server = new UiServer({
      config: {
        providers: [], candidates: [], runtime: { kind: 'inproc', modelsDir: await tempDir('aas-ext-models-'), autoFetch: false },
        agent: { root: await tempDir('aas-ext-root-'), approval: 'auto', verify: { enabled: false } }, initiative: { enabled: false },
        ...config,
      } as never,
      port: 0,
    });
    try { return await body((await server.start()).replace(/\/$/, ''), server); } finally { await server.stop(); }
  }
  const json = async (r: Response): Promise<Record<string, unknown>> => await r.json() as Record<string, unknown>;
  const post = (base: string, path: string, data: unknown = {}): Promise<Response> => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  const put = (base: string, data: unknown): Promise<Response> => fetch(`${base}/api/extensions`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  });

  test('切ると API が 404 を返し、パネルの種類が一覧から消える。入れ直すと、切る前に残した札が戻っている。設定にも書かれる', async () => {
    await withServer({}, async (base) => {
      const list = await json(await fetch(`${base}/api/extensions`));
      assert.deepEqual((list.extensions as Array<{ id: string; enabled: boolean; panel: string }>).map((e) => [e.id, e.enabled, e.panel]), [['ideas', true, 'ideas']]);
      const got = await json(await post(base, '/api/ideas/receive', { seed: 7 }));
      const cards = got.cards as Array<{ id: string; original: string }>;
      assert.ok(cards.length >= 3);
      assert.equal((await post(base, '/api/ideas/rate', { id: cards[0]!.id, value: 1 })).status, 200);
      const before = await json(await fetch(`${base}/api/ideas/browse`));
      assert.equal((before.saved as unknown[]).length, 1);
      assert.ok(((await json(await fetch(`${base}/api/layout`))).kinds as string[]).includes('ideas'));

      const off = await json(await put(base, { id: 'ideas', enabled: false }));
      assert.deepEqual((off.extensions as Array<{ enabled: boolean }>).map((e) => e.enabled), [false]);
      assert.deepEqual(JSON.parse(await readFile(process.env.AAS_CONFIG!, 'utf8')).extensions, { ideas: { enabled: false } });
      for (const [method, path] of [['GET', '/api/ideas/browse'], ['GET', '/api/ideas/list_themes'], ['POST', '/api/ideas/receive'], ['POST', '/api/ideas/rate'], ['GET', '/api/ideas']] as const) {
        const r = method === 'GET' ? await fetch(`${base}${path}`) : await post(base, path, { seed: 1 });
        assert.equal(r.status, 404, `${method} ${path}`);
        assert.match(String((await json(r)).error), /切ってあります/);
      }
      const layout = await json(await fetch(`${base}/api/layout`));
      assert.ok(!(layout.kinds as string[]).includes('ideas'));
      assert.deepEqual(layout.off, ['ideas']);
      assert.equal(existsSync(join(HOME, 'extensions', 'ideas', 'store.json')), true, '切っただけで、データが消えた');

      await put(base, { id: 'ideas', enabled: true });
      assert.deepEqual(await json(await fetch(`${base}/api/ideas/browse`)), before);
      assert.deepEqual((await json(await fetch(`${base}/api/layout`))).off, []);
    });
  });

  test('設定で切ってあれば、起こしたときから 404。入り切りの口は、知らない id と真偽でない値を断る', async () => {
    await withServer({ extensions: { ideas: { enabled: false } } }, async (base) => {
      assert.equal((await post(base, '/api/ideas/receive')).status, 404);
      assert.equal((await put(base, { id: 'nope', enabled: true })).status, 400);
      assert.equal((await put(base, { id: 'ideas', enabled: 'yes' })).status, 400);
      assert.equal((await post(base, '/api/ideas/receive')).status, 404, '断ったのに、入った');
    });
  });

  test('モデルが無くても札が出る。磨きは、理由を言って何もしない。語でないもの・覚えていない札は 400 で理由を返す', async () => {
    await withServer({}, async (base) => {
      const a = await json(await post(base, '/api/ideas/receive', { seed: 11 }));
      const b = await json(await post(base, '/api/ideas/receive', { seed: 11 }));
      const texts = (r: Record<string, unknown>): string[] => (r.cards as Array<{ original: string }>).map((c) => c.original);
      assert.deepEqual(texts(a), texts(b));
      const polish = await json(await post(base, '/api/ideas/polish', { ids: [(a.cards as Array<{ id: string }>)[0]!.id] }));
      assert.equal(typeof polish.skipped, 'string');
      assert.equal(polish.cards, undefined);
      const bad = await post(base, '/api/ideas/register_theme', { term: 'これは 文です。' });
      assert.equal(bad.status, 400);
      assert.match(String((await json(bad)).error), /語を 1 つ/);
      assert.equal((await post(base, '/api/ideas/follow_chain', { id: 'c99999' })).status, 400);
      assert.equal((await post(base, '/api/ideas/rate', { id: 'c1' })).status, 400);
      assert.equal((await post(base, '/api/ideas/nope')).status, 404);
      const themes = await json(await post(base, '/api/ideas/register_theme', { term: '棚卸し' }));
      assert.deepEqual((themes.themes as Array<{ term: string }>)[0], { term: '棚卸し', from: 'added' });
      const status = await json(await fetch(`${base}/api/ideas/stock_status`));
      assert.deepEqual([status.terms, status.templates, status.mechanisms, status.added], [169, 18, 57, 1]);
      await post(base, '/api/ideas/remove_theme', { term: '棚卸し' });
      // 思いつきを置く・育てる・筋を開き直す
      const planted = await json(await post(base, '/api/ideas/plant', { text: '通知が多すぎて読まれない', seed: 3 }));
      const thread = planted.thread as { id: string; words: string[] };
      const first = (planted.cards as Array<{ id: string; material: string }>)[0]!;
      assert.deepEqual(thread.words, ['通知']);
      assert.equal(first.material, '通知');
      const grown = await json(await post(base, '/api/ideas/grow', { thread: thread.id, id: first.id, seed: 4 }));
      assert.deepEqual((grown.thread as { steps: Array<{ id: string }> }).steps.map((c) => c.id), [first.id]);
      assert.equal((grown.cards as unknown[]).length, 3);
      const listed = (await json(await fetch(`${base}/api/ideas/threads`))).threads as Array<{ id: string; asText: string }>;
      assert.equal(listed[0]!.id, thread.id);
      assert.match(listed[0]!.asText, /^思いつき: 通知が多すぎて読まれない\n1\. /);
      assert.equal((await post(base, '/api/ideas/plant', { text: '' })).status, 400);
      assert.equal((await post(base, '/api/ideas/grow', { thread: 't99999' })).status, 400);
    });
  });
});

describe('スマホの口（LAN）', () => {
  test('パスフレーズで繋いだスマホからも、拡張機能の API には届かない（PC の画面の口からは届く）', async () => {
    const server = new UiServer({
      config: {
        providers: [], candidates: [], runtime: { kind: 'inproc', modelsDir: await tempDir('aas-ext-models-'), autoFetch: false },
        agent: { root: await tempDir('aas-ext-root-'), approval: 'auto', verify: { enabled: false } }, initiative: { enabled: false },
      } as never,
      port: 0, phoneAddresses: ['127.0.0.1'], phonePort: 0,
    });
    const base = (await server.start()).replace(/\/$/, '');
    try {
      const send = (url: string, data: unknown, headers: Record<string, string> = {}): Promise<Response> => fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data),
      });
      assert.equal((await send(`${base}/api/phone`, { enabled: true })).status, 200);
      const phone = await (await fetch(`${base}/api/phone`)).json() as { urls: string[]; passphrase: string };
      const lan = new URL(phone.urls[0]!).origin;
      const paired = await send(`${lan}/api/phone/pair`, { passphrase: phone.passphrase });
      const cookie = (paired.headers.get('set-cookie') ?? '').split(';')[0]!;
      assert.equal((await fetch(`${lan}/api/events/seq`, { headers: { cookie } })).status, 200, '繋げていない（この試験の前提）');
      assert.equal((await send(`${lan}/api/ideas/receive`, { seed: 1 }, { cookie })).status, 404);
      assert.equal((await fetch(`${lan}/api/ideas/browse`, { headers: { cookie } })).status, 404);
      assert.equal((await send(`${base}/api/ideas/receive`, { seed: 1 })).status, 200);
    } finally { await server.stop(); }
  });
});

describe('片づけ', () => {
  test('切ってある拡張機能のデータだけを挙げる。消すと、フォルダごと無くなる', async () => {
    const dir = join(await tempDir('aas-ext-clean-'), 'extensions', 'ideas');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'store.json'), '{"version":1}');
    const none = await findRemovable({ keepTag: 'b9999' });
    assert.deepEqual(none.filter((f) => f.path === dir), [], '渡していないのに挙げた');
    const found = (await findRemovable({ keepTag: 'b9999', offExtensions: [{ name: 'アイデア', dir }, { name: '無い', dir: join(dir, 'nope') }] }))
      .filter((f) => f.why.includes('拡張機能'));
    assert.deepEqual(found.map((f) => f.path), [dir]);
    assert.match(found[0]!.why, /切ってある拡張機能「アイデア」のデータ/);
    assert.ok(found[0]!.bytes > 0);
    await remove(found);
    assert.equal(existsSync(dir), false);
    assert.deepEqual(await readdir(join(dir, '..')), []);
  });
});
