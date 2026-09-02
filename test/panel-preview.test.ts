/**
 * 画面の「見る」板（HTML/CSS を作りながら見る）。
 *
 * 作りかけのページを、こちらの画面と**同じ出所で出さない**。
 * 同じ口から出すと、書いたページが /api/send を叩けてしまう。
 * 口が分かれていることと、それでも枠側で縛っていることを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';

installDom();
const { PANELS, TITLES } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
  TITLES: Record<string, string>;
};

async function draw(answer: unknown = { url: 'http://127.0.0.1:4176/', root: '/work' }, ok = true) {
  (globalThis as { fetch?: unknown }).fetch = (async () =>
    (ok ? Response.json(answer) : Response.json(answer, { status: 500 }))) as unknown as typeof fetch;
  (globalThis as { window?: unknown }).window = { open: () => undefined };
  const body = createNode('div');
  PANELS.preview!(body, { on: () => {} });
  await new Promise((r) => setTimeout(r, 20));
  return body;
}

/** 板の中から、種類で節を探す。 */
function find(body: StubNode, tag: string): StubNode | undefined {
  const out: StubNode[] = [];
  const walk = (n: StubNode) => {
    if (n.tagName === tag) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(body);
  return out[0];
}

describe('見る板', () => {
  test('見出しがある', () => {
    assert.equal(TITLES.preview, '見る');
  });

  test('別の口から出す。こちらの画面と同じ出所にしない', async () => {
    const body = await draw();
    const frame = find(body, 'iframe');
    assert.ok(frame, '枠が無い');
    // 4174 は画面の口。そこと同じにならないこと。
    assert.match(String((frame as StubNode & { src?: unknown }).src), /^http:\/\/127\.0\.0\.1:4176\//);
  });

  test('枠の側でも縛る', async () => {
    const body = await draw();
    const frame = find(body, 'iframe');
    // 出所が分かれていても、こちらでも縛る。
    // allow-same-origin を入れると縛った意味が無くなる。
    const sandbox = String((frame as StubNode & { sandbox?: unknown }).sandbox);
    assert.match(sandbox, /allow-scripts/);
    assert.doesNotMatch(sandbox, /allow-same-origin/);
  });

  test('どこを見ているかを出す', async () => {
    const body = await draw();
    assert.match(body.text, /\/work/);
    assert.match(body.text, /4176/);
  });

  test('口を開けなかったら、そう言う', async () => {
    const body = await draw({ error: '作業場がありません' }, false);
    assert.match(body.text, /作業場がありません/);
  });
});
