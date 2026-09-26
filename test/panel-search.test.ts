/**
 * 探すパネル。
 *
 * **画面には探す口が一つも無かった。**モデルは `search_text` を持っているのに、
 * 使う側は「あの文字がどこに在るか」を見る手段が無い。開いて直すための画面
 * としては、これが無いと一覧を上から開いて回ることになる。
 *
 * 当たった行を押したら、その行が開くところまで見る。開くだけでは足りない
 * （1000 行の頭が出ても、探している行は画面の外に在る）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';
import { until } from './until.ts';

installDom();
const { PANELS, TITLES } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
  TITLES: Record<string, string>;
};

interface Answer { hits?: Array<{ path: string; line: number; text: string }>; capped?: boolean; walkCapped?: boolean; tooBig?: number; unreadable?: number; error?: string; status?: number }

/** パネルを開く。`/api/search` は `answer` を返す。叩いた先も控える。 */
function open(answer: Answer) {
  const asked: string[] = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string) => {
    asked.push(String(url));
    const { status = 200, ...body } = answer;
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
  const opened: Array<{ path: string; line?: number }> = [];
  const body = createNode('div');
  PANELS.search!(body, {
    on: () => undefined,
    revealFile: (path: string, line?: number) => opened.push({ path, line }),
  });
  const find = (want: (n: StubNode) => boolean): StubNode | undefined => {
    if (want(body)) return body;
    const walk = (n: StubNode): StubNode | undefined => {
      if (want(n)) return n;
      for (const c of n.children) { const got = walk(c); if (got) return got; }
      return undefined;
    };
    return walk(body);
  };
  const dump = (n: StubNode): string => {
    let out = n.textContent ?? '';
    for (const c of n.children) out += ` ${dump(c)}`;
    return out;
  };
  return { body, asked, opened, find, text: () => dump(body) };
}

const input = (t: ReturnType<typeof open>, cls: string): StubNode => {
  const got = t.find((n) => (n.className ?? '').includes(cls));
  assert.ok(got, `${cls} が無い`);
  return got;
};

const press = (t: ReturnType<typeof open>, label: string): void => {
  const got = t.find((n) => n.textContent === label && typeof n.onclick === 'function');
  assert.ok(got, `「${label}」が押せません`);
  got.onclick!();
};

describe('探すパネル', () => {
  test('名前は「探す」', () => { assert.equal(TITLES.search, '探す'); });

  test('**打った文字で探しに行く**', async () => {
    const t = open({ hits: [{ path: 'src/a.ts', line: 12, text: 'const answer = 41;' }] });
    input(t, 'search-q').value = 'answer';
    press(t, '探す');
    await until(() => t.asked.length > 0, '探しに行く');
    assert.match(t.asked[0]!, /\/api\/search\?q=answer/, `叩き先が違います: ${t.asked[0]}`);
    await until(() => t.text().includes('src/a.ts:12'), '当たった行が並ぶ');
    assert.ok(t.text().includes('const answer = 41;'), `中身が出ていません: ${t.text()}`);
  });

  test('場所を入れたら、その下だけ探す', async () => {
    const t = open({ hits: [] });
    input(t, 'search-q').value = 'x';
    input(t, 'search-where').value = 'src/ui';
    press(t, '探す');
    await until(() => t.asked.length > 0, '探しに行く');
    assert.match(t.asked[0]!, /path=src%2Fui/, `場所を渡していません: ${t.asked[0]}`);
  });

  test('**当たった行を押すと、その行が開く**', async () => {
    const t = open({ hits: [{ path: 'src/a.ts', line: 12, text: 'const answer = 41;' }] });
    input(t, 'search-q').value = 'answer';
    press(t, '探す');
    await until(() => t.text().includes('src/a.ts:12'), '当たった行が並ぶ');
    press(t, 'src/a.ts:12');
    assert.deepEqual(t.opened, [{ path: 'src/a.ts', line: 12 }],
      `行まで渡していません: ${JSON.stringify(t.opened)}`);
  });

  test('**見ていない分を、無かったことにしない**', async () => {
    const t = open({
      hits: [{ path: 'src/a.ts', line: 1, text: 'x' }],
      capped: true, walkCapped: true, tooBig: 3, unreadable: 2,
    });
    input(t, 'search-q').value = 'x';
    press(t, '探す');
    await until(() => t.text().includes('打ち切りました'), '打ち切りを言う');
    assert.ok(t.text().includes('途中までしか見ていません'), `見ていない分を言っていません: ${t.text()}`);
    assert.ok(t.text().includes('3 個'), `開いていない分を言っていません: ${t.text()}`);
    assert.ok(t.text().includes('utf8 で読めないため見ていないファイルが 2 個'), `読めずに見ていない分を言っていません: ${t.text()}`);
  });

  test('見つからなければ、そう言う（対）', async () => {
    const t = open({ hits: [] });
    input(t, 'search-q').value = 'どこにも無い';
    press(t, '探す');
    await until(() => t.text().includes('見つかりませんでした'), 'そう言う');
  });

  test('空のまま押しても、探しに行かない（対）', async () => {
    const t = open({ hits: [] });
    press(t, '探す');
    await until(() => t.text().includes('探す文字を入れてください'), '案内を出す');
    assert.deepEqual(t.asked, [], `空で探しに行きました: ${t.asked.join(',')}`);
  });

  test('断られたら、その理由を出す', async () => {
    const t = open({ error: '作業ディレクトリの外です: ../etc', status: 400 });
    input(t, 'search-q').value = 'x';
    press(t, '探す');
    await until(() => t.text().includes('作業ディレクトリの外です'), '理由が出る');
  });
});

/**
 * **探した所を、会話へ渡す。**
 *
 * 見つけた行を AI に訊くとき、道と行を打ち直していた（`src/a.ts:120`）。
 * 打ち間違えれば、別の所の話になる。押した所から渡す。
 */
describe('探した所を、依頼に添える', () => {
  /** 会話へ渡ったものを控えるパネル。 */
  function openWithChat(answer: Answer) {
    const asked: string[] = [];
    (globalThis as { fetch?: unknown }).fetch = (async (url: string) => {
      asked.push(String(url));
      const { status = 200, ...body } = answer;
      return Response.json(body, { status });
    }) as unknown as typeof fetch;
    const sent: string[] = [];
    const body = createNode('div');
    PANELS.search!(body, {
      on: () => undefined,
      revealFile: () => undefined,
      insertText: (text: string) => { sent.push(text); return true; },
    });
    const find = (want: (n: StubNode) => boolean): StubNode | undefined => {
      const walk = (n: StubNode): StubNode | undefined => {
        if (want(n)) return n;
        for (const c of n.children) { const got = walk(c); if (got) return got; }
        return undefined;
      };
      return walk(body);
    };
    const dump = (n: StubNode): string => {
      let out = n.textContent ?? '';
      for (const c of n.children) out += ` ${dump(c)}`;
      return out;
    };
    return { body, sent, find, text: () => dump(body) };
  }

  test('**@ を押すと、道と行が会話へ渡る**', async () => {
    const t = openWithChat({ hits: [{ path: 'src/a.ts', line: 12, text: 'const answer = 41;' }] });
    const q = t.find((n) => (n.className ?? '').includes('search-q'))!;
    q.value = 'answer';
    t.find((n) => n.textContent === '探す' && typeof n.onclick === 'function')!.onclick!();
    await until(() => t.text().includes('src/a.ts:12'), '当たった行が並ぶ');
    const ask = t.find((n) => (n.className ?? '').includes('search-ask'));
    assert.ok(ask, '会話へ渡す押し場所がありません');
    ask.onclick!();
    assert.deepEqual(t.sent, ['src/a.ts:12'], `渡ったものが違います: ${JSON.stringify(t.sent)}`);
  });

  test('開くのと、渡すのは別（押し間違えない）', async () => {
    const t = openWithChat({ hits: [{ path: 'src/a.ts', line: 12, text: 'x' }] });
    t.find((n) => (n.className ?? '').includes('search-q'))!.value = 'x';
    t.find((n) => n.textContent === '探す' && typeof n.onclick === 'function')!.onclick!();
    await until(() => t.text().includes('src/a.ts:12'), '当たった行が並ぶ');
    // 道を押しても、会話へは渡らない（開くだけ）。
    t.find((n) => n.textContent === 'src/a.ts:12')!.onclick!();
    assert.deepEqual(t.sent, [], `開くつもりで渡っています: ${JSON.stringify(t.sent)}`);
  });
});
