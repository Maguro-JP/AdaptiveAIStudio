/**
 * ログのパネルは、開き直しても消えない。
 *
 * 行を DOM にしか持っていなかったので、配置を変える・パネルを出し入れする・設定を
 * 閉じる（描き直す）たびに全部消えた（実機）。過去分は本体（/api/logs）が持ち、
 * パネルは開いたとき取り直す。届く分は番号で重ねない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';
import { until } from './until.ts';

installDom();
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

type LogLine = { seq: number; level: string; text: string };

/** パネルを開く。/api/logs は `past` を返す（`release` を呼ぶまで返さない）。 */
function open(past: LogLine[]) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  (globalThis as { fetch?: unknown }).fetch = (async (url: string) => {
    assert.ok(String(url).includes('/api/logs'), `知らない先を叩いた: ${url}`);
    await gate;
    return Response.json({ lines: past });
  }) as unknown as typeof fetch;
  const handlers: Array<(e: unknown) => void> = [];
  const body = createNode('div');
  PANELS.log!(body, { on: (type: string, fn: (e: unknown) => void) => { if (type === 'log') handlers.push(fn); } });
  const emit = (e: LogLine) => { for (const fn of handlers) fn(e); };
  const lines = () => body.children.filter((c) => c.className.includes('log-line')).map((c) => c.textContent);
  return { body, emit, release, lines };
}

describe('ログのパネル', () => {
  test('開いたら過去分を本体から取り直す。取り直している間に届いた分は、その後ろに並ぶ', async () => {
    const { emit, release, lines } = open([{ seq: 1, level: 'info', text: '一行目' }, { seq: 2, level: 'info', text: '二行目' }]);
    // 取り直しが返る前に、新しい一行が届く。
    emit({ seq: 3, level: 'info', text: '三行目' });
    assert.deepEqual(lines(), [], '取り直す前に出している（順が崩れる）');
    release();
    await until(() => lines().length === 3, '三行そろう');
    assert.deepEqual(lines(), ['一行目', '二行目', '三行目']);
  });

  test('同じ番号の行は重ねない。新しい番号は足す', async () => {
    const { emit, release, lines } = open([{ seq: 5, level: 'info', text: '五' }]);
    release();
    await until(() => lines().length === 1, '過去分が出る');
    emit({ seq: 5, level: 'info', text: '五' });
    emit({ seq: 4, level: 'info', text: '四（古い）' });
    emit({ seq: 6, level: 'warn', text: '六' });
    assert.deepEqual(lines(), ['五', '六']);
  });

  test('番号の無い行（古い本体）も、そのまま出す（対）', async () => {
    const { emit, release, lines, body } = open([]);
    release();
    emit({ level: 'error', text: '番号なし' } as LogLine);
    await until(() => lines().length === 1, '届いた分が出る');
    assert.deepEqual(lines(), ['番号なし']);
    assert.ok(body.children.find((c) => c.textContent === '番号なし')!.className.includes('bad'));
  });

  test('本体から取れなくても、届く分は出す（対）', async () => {
    (globalThis as { fetch?: unknown }).fetch = (async () => { throw new Error('落ちている'); }) as unknown as typeof fetch;
    const handlers: Array<(e: unknown) => void> = [];
    const body = createNode('div');
    PANELS.log!(body, { on: (_t: string, fn: (e: unknown) => void) => handlers.push(fn) });
    await until(() => true, 'ひと呼吸');
    await new Promise((r) => setImmediate(r));
    for (const fn of handlers) fn({ seq: 1, level: 'info', text: '来た' });
    await until(() => body.children.some((c) => c.textContent === '来た'), '届いた分が出る');
  });
});
