/**
 * エディタのパネルを、押して動かす。
 *
 * ここまでエディタの試験は、`panels.js` の中に決まった文字が在るかを
 * 見るだけだった。文字が在ることは、押したときに動くことを言わない。
 *
 * 実際に、保存したあとの「保存しました（+2 -1）」が消えていた。
 * 手で保存すると本体が差分を全員へ配り、配られた写しでこのパネルが
 * 同じファイルを読み直して、出ている言葉を上書きしていた。
 * 書けたのか、何行変わったのかが画面から消える。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';
import { until } from './until.ts';

installDom();
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

/**
 * パネルを開く。ファイルの中身は `disk` が返し、叩いた先と PUT を控える。
 *
 * **覚えておく所は、毎回まっさらにする。**保存していない直しはそこへ預かるので、
 * 前の試験の分が残っていると、開いた瞬間にそれが戻ってくる（実際に 4 件落ちた）。
 * 預かりそのものを見る試験は、`keep` を渡して残す。
 */
/** この試験で作ったパネル。預かりを消して始めるときに、前の試験のパネルも閉じる（生きたまま残すと、同じ名前の
 * ファイルの預かりを後から書き、こちらの試験の預かりを「生きている別のパネルのもの」として断らせる）。 */
const made: StubNode[] = [];
function fresh(): void {
  localStorage.clear();
  for (const b of made.splice(0)) (b as unknown as { isConnected: boolean }).isConnected = false;
}

function open(disk: Record<string, string>, keep = false, extra: Record<string, unknown> = {}) {
  if (!keep) fresh();
  const asked: Array<{ url: string; method: string; body?: unknown }> = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) as { path: string; content: string } : undefined;
    asked.push({ url: String(url), method, body });
    if (String(url).includes('/api/complete')) {
      return Response.json({ text: '', why: '/長い/道/のどこかに GGUF がありません。設定 → モデル に、いま見ている保存先が出ています。そこへ .gguf を1つ置いてください。' });
    }
    if (method === 'PUT') {
      /*
       * 本体と同じように、**開いたあとで変わっていたら断る。**
       * ここでは中身そのものを stamp として使う（同じ中身なら同じ、違えば違う）。
       */
      const sent = (body as { stamp?: string }).stamp;
      if (sent !== undefined && disk[body!.path] !== undefined && disk[body!.path] !== sent) {
        return Response.json(
          { error: '別の所で変わりました', conflict: true, content: disk[body!.path], stamp: disk[body!.path] },
          { status: 409 },
        );
      }
      disk[body!.path] = body!.content;
      return Response.json({ saved: true, path: body!.path, added: 1, removed: 1, stamp: body!.content });
    }
    const path = decodeURIComponent(String(url).split('path=')[1] ?? '');
    const content = disk[path];
    if (content === undefined) return Response.json({ error: '無い' }, { status: 404 });
    return Response.json({ path, content, stamp: content });
  }) as unknown as typeof fetch;

  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const body = createNode('div');
  made.push(body);
  const ctx: Record<string, unknown> = {
    ...extra,
    on: (type: string, fn: (e: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn);
    },
  };
  PANELS.editor!(body, ctx);
  const emit = (type: string, event: unknown) => {
    for (const fn of handlers.get(type) ?? []) fn({ event });
  };
  /** パネルの中を、種類で探す。 */
  const find = (want: (n: StubNode) => boolean): StubNode => {
    const walk = (n: StubNode): StubNode | undefined => {
      if (want(n)) return n;
      for (const c of n.children) { const got = walk(c); if (got) return got; }
      return undefined;
    };
    const got = walk(body);
    assert.ok(got, '見つからない');
    return got;
  };
  /** 押せるものを、書いてある字で探す。 */
  const press = (label: string): void => {
    const got = find((n) => n.tagName === 'button' && n.textContent === label);
    got.onclick!();
  };
  const at = (cls: string) => find((n) => n.className.includes(cls));
  return {
    emit, asked, ctx, find, press, at,
    /** パネルを閉じる（画面から切り離す）。閉じたパネルの預かりは、後から開いたパネルが引き取る。 */
    close: () => { (body as unknown as { isConnected: boolean }).isConnected = false; },
    area: () => find((n) => n.tagName === 'textarea'),
    state: () => find((n) => n.className.includes('editor-state')),
    save: () => find((n) => n.tagName === 'button'),
    /** Ctrl+◯ を、欄に手が在る形で打つ。 */
    key: (key: string, more: Record<string, unknown> = {}) => {
      const area = find((n) => n.tagName === 'textarea');
      area.onkeydown!({ key, ctrlKey: true, preventDefault: () => undefined, ...more });
    },
  };
}

describe('エディタのパネル', () => {
  /**
   * **選んだ範囲を、Tab で消さない。**
   *
   * Tab は選んでいる範囲を空白二つで置き換えていた。数行選んで Tab を押すと、
   * **選んだ行が丸ごと空白二つになる**（書いたものが消える）。字下げのつもりで
   * 押して失う形で、取り返しがつかない（保存前なら戻せるが、気づかない）。
   *
   * 数行にまたがる選択は、行ごとに字下げする。Shift+Tab で戻す。
   * 一行の中の選択とカーソルだけのときは、これまでどおり空白二つを入れる
   * （普通のエディタもそうする）。
   */
  test('**数行を選んで Tab を押しても、選んだ行が消えない（行ごとに字下げ）**', async () => {
    const disk = { 'a.ts': 'one\ntwo\nthree\n' };
    const { area, ctx, key } = open(disk);
    (ctx.openFile as (p: string) => void)('a.ts');
    await until(() => area().value === 'one\ntwo\nthree\n', 'ファイルが開く');

    // 1〜2 行目を選ぶ（one\ntwo）。
    area().setSelectionRange(0, 7);
    key('Tab', { ctrlKey: false });
    assert.equal(area().value, '  one\n  two\nthree\n', `字下げになっていない: ${JSON.stringify(area().value)}`);
    // 選んだ範囲は選んだまま（続けて押せる）。
    assert.equal(area().value.slice(area().selectionStart, area().selectionEnd), '  one\n  two');

    // Shift+Tab で戻る。
    key('Tab', { ctrlKey: false, shiftKey: true });
    assert.equal(area().value, 'one\ntwo\nthree\n', `戻っていない: ${JSON.stringify(area().value)}`);
  });

  test('行を丸ごと選ぶと終わりは次の行の頭に来るが、その行は字下げしない', async () => {
    const disk = { 'a.ts': 'one\ntwo\nthree\n' };
    const { area, ctx, key } = open(disk);
    (ctx.openFile as (p: string) => void)('a.ts');
    await until(() => area().value === 'one\ntwo\nthree\n', 'ファイルが開く');
    area().setSelectionRange(0, 8); // one\ntwo\n まで（three の頭で終わる）
    key('Tab', { ctrlKey: false });
    assert.equal(area().value, '  one\n  two\nthree\n', `選んでいない行まで字下げした: ${JSON.stringify(area().value)}`);
    key('Tab', { ctrlKey: false, shiftKey: true });
    assert.equal(area().value, 'one\ntwo\nthree\n', `戻っていない: ${JSON.stringify(area().value)}`);
  });

  /**
   * **Enter で、字下げが消える。**
   *
   * 字下げした行の終わりで改行すると、次の行は必ず頭（0 列）から始まっていた。
   * 深い所を書くたびに、人が空白を打ち直すことになる。普通のエディタは引き継ぐ。
   *
   * 変換中の Enter（日本語の確定）では何もしない。そこを奪うと、確定のたびに
   * 余分な改行が入る（会話の欄で実際にやった形）。
   */
  test('**Enter で、前の行の字下げを引き継ぐ**', async () => {
    const disk = { 'a.ts': 'if (x) {\n    deep\n}\n' };
    const { area, ctx, key } = open(disk);
    (ctx.openFile as (p: string) => void)('a.ts');
    await until(() => area().value.includes('deep'), 'ファイルが開く');

    // 「    deep」の終わり（13 文字目）で改行する。
    const at = area().value.indexOf('deep') + 'deep'.length;
    area().setSelectionRange(at, at);
    key('Enter', { ctrlKey: false });
    assert.equal(area().value, 'if (x) {\n    deep\n    \n}\n',
      `字下げを引き継いでいない: ${JSON.stringify(area().value)}`);
    assert.equal(area().selectionStart, at + 5, 'カーソルが字下げの後に来ていない');
  });

  test('変換中の Enter では、何もしない（対）', async () => {
    const disk = { 'a.ts': '  x\n' };
    const { area, ctx, key } = open(disk);
    (ctx.openFile as (p: string) => void)('a.ts');
    await until(() => area().value === '  x\n', 'ファイルが開く');
    area().setSelectionRange(3, 3);
    let stopped = false;
    key('Enter', { ctrlKey: false, isComposing: true, preventDefault: () => { stopped = true; } });
    assert.equal(stopped, false, '変換中の Enter を奪っている（確定のたびに改行が入る）');
    assert.equal(area().value, '  x\n', '変換中なのに書き換えている');
  });

  test('カーソルだけのときは、これまでどおり空白二つ（対）', async () => {
    const disk = { 'a.ts': 'x\n' };
    const { area, ctx, key } = open(disk);
    (ctx.openFile as (p: string) => void)('a.ts');
    await until(() => area().value === 'x\n', 'ファイルが開く');
    area().setSelectionRange(0, 0);
    key('Tab', { ctrlKey: false });
    assert.equal(area().value, '  x\n');
    assert.equal(area().selectionStart, 2, 'カーソルが字下げの後に来ていない');
  });

  test('Shift+Tab は、カーソルの行の字下げを戻す', async () => {
    const disk = { 'a.ts': '    deep\n' };
    const { area, ctx, key } = open(disk);
    (ctx.openFile as (p: string) => void)('a.ts');
    await until(() => area().value === '    deep\n', 'ファイルが開く');
    area().setSelectionRange(6, 6);
    key('Tab', { ctrlKey: false, shiftKey: true });
    assert.equal(area().value, '  deep\n', `戻っていない: ${JSON.stringify(area().value)}`);
  });

  test('**保存したあと、自分の書き込みの写しで言葉が消えない**', async () => {
    const disk = { 'a.txt': 'one\n' };
    const { emit, ctx, area, state, save } = open(disk);
    (ctx.openFile as (p: string) => void)('a.txt');
    await until(() => area().value === 'one\n', 'ファイルが開く');

    // 直して、保存を押す。
    area().value = 'two\n';
    area().fire('input');
    assert.equal(save().disabled, false, '直したのに保存が押せない');
    save().onclick!();
    await until(() => /保存しました/.test(state().textContent), '保存したと出る');
    assert.match(state().textContent, /\+1 -1/);
    assert.equal(disk['a.txt'], 'two\n', '書けていない');

    // 本体が配る差分（自分の書き込みの写し）が届く。
    emit('session', { type: 'diff', path: 'a.txt', diff: '@@ -1 +1 @@\n-one\n+two', added: 1, removed: 1, created: false });
    // 読み直しは非同期なので、届いたあとに入る隙を作ってから見る。
    await new Promise((r) => setTimeout(r, 30));
    assert.match(state().textContent, /保存しました/,
      `自分の写しで「保存しました」が消えている: ${state().textContent}`);
  });

  /**
   * 保存していない直しを、黙って捨てないこと。
   *
   * 横の一覧で別のファイルを押すと、読み直した中身をそのまま欄へ入れていた。
   * **確認も警告も無く、書いていたものが消える。**よそからの書き換えには
   * `!dirty()` の番が在るのに、人が別のファイルを開く道には無かった。
   */
  test('**別のファイルを開いても、保存していない直しは消えない**', async () => {
    const disk = { 'a.txt': 'aaa\n', 'b.txt': 'bbb\n' };
    const { ctx, area, state } = open(disk);
    const openFile = ctx.openFile as (p: string) => void;
    openFile('a.txt');
    await until(() => area().value === 'aaa\n', 'a.txt が開く');

    // まだ保存していない直し。
    area().value = 'まだ保存していない大事な直し\n';
    area().fire('input');
    assert.match(state().textContent, /直しています/);

    // 横の一覧で b.txt を押す。
    openFile('b.txt');
    await until(() => area().value === 'bbb\n', 'b.txt が開く');

    // a.txt へ戻ると、直しが返ってくる。
    openFile('a.txt');
    await until(() => area().value === 'まだ保存していない大事な直し\n',
      `保存していない直しが消えた: ${area().value}`);
    assert.match(state().textContent, /戻しました/, state().textContent);
    assert.equal(disk['a.txt'], 'aaa\n', '勝手に保存している');
  });

  test('よそで書き換わったら、読み直して入れ替える（対）', async () => {
    const disk = { 'a.txt': 'one\n' };
    const { emit, ctx, area, state } = open(disk);
    (ctx.openFile as (p: string) => void)('a.txt');
    await until(() => area().value === 'one\n', 'ファイルが開く');

    // モデルが書き換えた形。中身が変わっているので、入れ替える。
    disk['a.txt'] = 'model\n';
    emit('session', { type: 'diff', path: 'a.txt', diff: '@@ -1 +1 @@\n-one\n+model', added: 1, removed: 1, created: false });
    await until(() => area().value === 'model\n', 'よその書き換えを読み直す');
    assert.match(state().textContent, /保存してあります/, state().textContent);
  });
});

/**
 * 行番号・探す・置き換える・行へ飛ぶ。
 *
 * **どれも無かった。**落ちた場所は「a.ts:128」の形で来るし、探した結果も行で
 * 来るのに、画面には行が一つも出ていないので数えるしかない。1000 行のファイルで
 * 目当ての字を探すのも、目で追うしかなかった。直すための画面として要る所。
 */
describe('エディタで、探して直す', () => {
  const lines = ['const a = 1;', 'const b = 2;', 'const a2 = a;', 'end'].join('\n');

  const opened = async () => {
    const t = open({ 'a.ts': lines });
    (t.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => t.area().value === lines, 'ファイルが開く');
    return t;
  };

  test('**行番号が出る**', async () => {
    const t = await opened();
    const gutter = t.at('editor-lines');
    assert.equal(gutter.textContent, '1\n2\n3\n4\n', `行番号が合っていません: ${JSON.stringify(gutter.textContent)}`);
  });

  test('行を足したら、行番号も増える', async () => {
    const t = await opened();
    t.area().value = `${lines}\nmore`;
    t.area().fire('input');
    assert.equal(t.at('editor-lines').textContent, '1\n2\n3\n4\n5\n');
  });

  test('**Ctrl+F で探す所が出る**', async () => {
    const t = await opened();
    assert.equal(t.at('editor-find').hidden, true, '最初から出ています');
    t.key('f');
    assert.equal(t.at('editor-find').hidden, false, 'Ctrl+F で出ていません');
  });

  test('**次へで、当たった所を選ぶ**', async () => {
    const t = await opened();
    t.key('f');
    t.at('find-q').value = 'const';
    t.at('find-q').fire('input');
    t.press('次へ');
    const area = t.area();
    assert.equal(area.value.slice(area.selectionStart, area.selectionEnd), 'const');
    assert.equal(area.selectionStart, 0, `最初の当たりではありません: ${area.selectionStart}`);
    t.press('次へ');
    assert.equal(t.area().selectionStart, lines.indexOf('const', 1), '次へ進んでいません');
  });

  test('**端まで行ったら、反対の端から続ける**', async () => {
    const t = await opened();
    t.key('f');
    t.at('find-q').value = 'end';
    t.at('find-q').fire('input');
    t.press('次へ');
    const first = t.area().selectionStart;
    t.press('次へ');
    assert.equal(t.area().selectionStart, first, '一周して戻っていません');
  });

  test('何件在るかを出す', async () => {
    const t = await opened();
    t.key('f');
    t.at('find-q').value = 'const';
    t.at('find-q').fire('input');
    assert.equal(t.at('find-count').textContent, '3 件');
    t.at('find-q').value = 'どこにも無い';
    t.at('find-q').fire('input');
    assert.equal(t.at('find-count').textContent, '見つかりません');
  });

  test('**置換は、選んでいる所だけを替える**', async () => {
    const t = await opened();
    t.key('f');
    t.at('find-q').value = 'const';
    t.at('find-q').fire('input');
    t.at('find-r').value = 'let';
    t.press('次へ');
    t.press('置換');
    assert.equal(t.area().value.split('\n')[0], 'let a = 1;');
    assert.equal(t.area().value.split('\n')[1], 'const b = 2;', '選んでいない所まで替えています');
  });

  /**
   * **押しても何も起きない回を作らない。**
   *
   * 探す文字を打っただけでは、欄では何も選んでいない。その状態で置換を押すと
   * 次の当たりへ動くだけで、一度目は何も置き換わらなかった（押して実測）。
   */
  test('**選んでいなくても、押した一度で置き換わる**', async () => {
    const t = await opened();
    t.key('f');
    t.at('find-q').value = 'const';
    t.at('find-q').fire('input');
    t.at('find-r').value = 'let';
    // 「次へ」を押さずに、いきなり置換。
    t.press('置換');
    assert.equal(t.area().value.split('\n')[0], 'let a = 1;', `一度押しただけでは置き換わらない: ${t.area().value}`);
    assert.equal(t.area().value.split('\n')[1], 'const b = 2;', '選んでいない所まで替えています');
  });

  test('当たりが無ければ、何も替えない（対）', async () => {
    const t = await opened();
    t.key('f');
    t.at('find-q').value = 'どこにも無い';
    t.at('find-q').fire('input');
    t.at('find-r').value = 'X';
    const before = t.area().value;
    t.press('置換');
    assert.equal(t.area().value, before, '当たりが無いのに書き換えている');
  });

  test('**全部置換は、全部替える**', async () => {
    const t = await opened();
    t.key('f');
    t.at('find-q').value = 'const';
    t.at('find-q').fire('input');
    t.at('find-r').value = 'let';
    t.press('全部');
    assert.equal(t.area().value.includes('const'), false, `残っています: ${t.area().value}`);
    assert.match(t.at('find-count').textContent, /3 件を置き換えました/);
    assert.match(t.state().textContent, /直しています/, '直したことになっていません');
  });

  test('**Ctrl+G で、行へ飛ぶ**', async () => {
    const t = await opened();
    t.key('g');
    assert.equal(t.at('editor-find').hidden, false);
    const box = t.at('find-line');
    box.value = '3';
    box.onkeydown!({ key: 'Enter', preventDefault: () => undefined });
    const area = t.area();
    assert.equal(area.value.slice(area.selectionStart, area.selectionEnd), 'const a2 = a;');
    assert.match(t.state().textContent, /3 行目/);
  });

  test('探す所は、× で閉じられる（対）', async () => {
    const t = await opened();
    t.key('f');
    t.press('×');
    assert.equal(t.at('editor-find').hidden, true);
  });
});

/**
 * 直している最中に、AI が同じファイルを書いたとき。
 *
 * ここまでは**何も言わずに人の版を出し続けていた**（上書きしないのは正しいが、
 * 黙っている）。ファイルは AI の版、欄は人の版、と二つに割れたまま、
 * 先に保存した方が相手を消す。どちらを残すかは人が決めることなので、
 * 起きたことを出して選ばせる。消さないので、押し間違いでも取り返しがつく。
 */
describe('AI が書き換えたことを、黙らない', () => {
  /** 開いて、保存していない直しを作る。 */
  async function editing(disk: Record<string, string>) {
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => box.area().value === disk['a.ts'], 'ファイルが開く');
    box.area().value = '人が書いた\n';
    box.area().oninput!();
    return box;
  }
  const notice = (box: ReturnType<typeof open>) => box.find((n) => n.className === 'editor-notice');

  test('**直している最中に書き換えられたら、そう言う**', async () => {
    const disk = { 'a.ts': 'はじめ\n' };
    const box = await editing(disk);
    disk['a.ts'] = 'AI が書いた\n';
    box.emit('session', { type: 'diff', path: 'a.ts' });
    const bar = notice(box);
    assert.equal(bar.hidden, false, '書き換えられたのに、何も出ていない');
    assert.match(bar.text, /AI がこのファイルを書き換えました/, bar.text);
    // 黙って上書きもしない。欄は人の版のまま。
    assert.equal(box.area().value, '人が書いた\n', '直している欄を上書きしている');
  });

  test('**AI の版を出しても、自分の直しに戻せる**', async () => {
    const disk = { 'a.ts': 'はじめ\n' };
    const box = await editing(disk);
    disk['a.ts'] = 'AI が書いた\n';
    box.emit('session', { type: 'diff', path: 'a.ts' });
    box.press('AI の版を出す');
    await until(() => box.area().value === 'AI が書いた\n', 'AI の版が出る');
    assert.match(notice(box).text, /預かっています/, notice(box).text);
    box.press('自分の直しに戻す');
    assert.equal(box.area().value, '人が書いた\n', '預かったものが戻らない');
  });

  test('直していなければ、これまでどおり読み直す（対）', async () => {
    const disk = { 'a.ts': 'はじめ\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => box.area().value === 'はじめ\n', 'ファイルが開く');
    disk['a.ts'] = 'AI が書いた\n';
    box.emit('session', { type: 'diff', path: 'a.ts' });
    await until(() => box.area().value === 'AI が書いた\n', '読み直す');
    assert.equal(notice(box).hidden, true, '直していないのに、選ばせている');
  });

  test('**保存で断られたら、どちらを残すか選ばせる**', async () => {
    const disk = { 'a.ts': 'はじめ\n' };
    const box = await editing(disk);
    // 帯を出さずに（出来事を流さずに）、ファイルだけが変わった場合。
    disk['a.ts'] = 'AI が書いた\n';
    box.key('s');
    await until(() => notice(box).hidden === false, '断られたことを出す');
    assert.match(notice(box).text, /保存していません/, notice(box).text);
    assert.equal(disk['a.ts'], 'AI が書いた\n', '断られたのに書いている');
    box.press('自分の版で上書きする');
    await until(() => disk['a.ts'] === '人が書いた\n', '上書きが通る');
  });
});

/**
 * **長い断りを、見出しへ流し込まない。**
 *
 * 「補完なし（…に GGUF がありません。設定 → モデル に…）」を見出しに入れていた
 * ので、見出しが 3 行に折れ、ファイル名が 47px まで潰れて「head-pro…」になり、
 * 保存の押し場所まで二段になっていた（本物のブラウザで測った）。
 * 見出しは一行のものだけにして、長い話は帯で読ませる。
 */
describe('補完が出せない理由は、見出しに流し込まない', () => {
  test('**見出しは短いまま、理由は帯に出る**', async () => {
    const disk = { 'a.ts': 'const x = 1;\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => box.area().value === 'const x = 1;\n', 'ファイルが開く');
    // 行の終わりにカーソルを置く（途中では補完を出さない作り）。
    box.area().setSelectionRange(13, 13);
    // 打つと、少し置いてから補完を訊きに行く。
    box.area().fire('input');
    await until(() => box.state().textContent === '補完なし', '補完の答えが返る', { timeoutMs: 10_000 });
    const bar = box.find((n) => n.className.startsWith('editor-notice'));
    assert.equal(bar.hidden, false, '理由がどこにも出ていない');
    assert.match(bar.text, /GGUF がありません/, bar.text);
    // ただの知らせなので、消えるものが在るときの帯とは見た目を変える。
    assert.ok(bar.className.includes('info'), `知らせの見た目になっていない: ${bar.className}`);
    // 見出しには長い文を入れない（潰れる）。
    assert.ok(box.state().textContent.length < 20, `見出しが長い: ${box.state().textContent}`);
  });

  /**
   * **ただの知らせで、消えるものが在る知らせを押しのけない。**
   *
   * 「AI が書き換えました」を出している最中に打つと、補完の断りが同じ帯へ来て、
   * 割れていることの知らせが消えていた（sweep で見つけた）。
   * 直している最中なので、打つのはむしろ普通のこと。
   */
  test('**書き換えの知らせは、補完の断りに消されない**', async () => {
    const disk = { 'a.ts': 'const x = 1;\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => box.area().value === 'const x = 1;\n', 'ファイルが開く');
    box.area().value = 'const x = 2;\n';
    box.area().oninput!();
    disk['a.ts'] = 'AI が書いた\n';
    box.emit('session', { type: 'diff', path: 'a.ts' });
    const bar = box.find((n) => n.className.startsWith('editor-notice'));
    assert.match(bar.text, /書き換えました/, bar.text);
    // ここで補完を訊きに行かせる（直している最中なので、打つのは普通のこと）。
    box.area().setSelectionRange(13, 13);
    box.area().fire('input');
    await until(() => box.state().textContent === '補完なし', '補完の答えが返る', { timeoutMs: 10_000 });
    assert.match(bar.text, /書き換えました/, `知らせが消えている: ${bar.text}`);
  });
});

/**
 * AI が、選んでいた所を書き換えたとき（`replace_selection`）。
 *
 * 入れ替えるのは欄の中だけで、保存はしない。選んだ所は人が動かせるので、
 * **渡された字がまだそこに在るときだけ**入れ替える。入れ替える前は預かって、
 * 「元に戻す」で戻せるようにする。
 */
describe('選んでいた所を、AI が書き換える', () => {
  async function opened() {
    const disk = { 'a.ts': 'const x = 1;\nconst y = 2;\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => box.area().value.includes('const x'), 'ファイルが開く');
    return box;
  }
  type Patch = { path: string; from: number; to: number; text: string; replacement: string };
  const patch = (box: Awaited<ReturnType<typeof opened>>, at: Patch) =>
    (box.ctx.applyPatch as (a: Patch) => boolean)(at);

  test('**選んでいた行だけ入れ替わり、他は残る**', async () => {
    const box = await opened();
    const done = patch(box, { path: 'a.ts', from: 1, to: 1, text: 'const x = 1;', replacement: 'const x = 42;' });
    assert.equal(done, true);
    assert.equal(box.area().value, 'const x = 42;\nconst y = 2;\n');
    // 保存はしない（人が見て決める）。
    assert.match(box.state().textContent, /直しています/, box.state().textContent);
  });

  test('**元に戻せる**', async () => {
    const box = await opened();
    patch(box, { path: 'a.ts', from: 1, to: 1, text: 'const x = 1;', replacement: 'const x = 42;' });
    box.press('元に戻す');
    assert.equal(box.area().value, 'const x = 1;\nconst y = 2;\n', '戻っていない');
  });

  test('選んでいた所が動いていたら、入れない（対）', async () => {
    const box = await opened();
    // 人が先に直した。渡された字は、もうそこに無い。
    box.area().value = 'const x = 999;\nconst y = 2;\n';
    box.area().oninput!();
    const done = patch(box, { path: 'a.ts', from: 1, to: 1, text: 'const x = 1;', replacement: 'const x = 42;' });
    assert.equal(done, false);
    assert.equal(box.area().value, 'const x = 999;\nconst y = 2;\n', '人の直しを上書きしている');
    const bar = box.find((n) => n.className.startsWith('editor-notice'));
    assert.match(bar.text, /入れられませんでした/, bar.text);
  });

  test('別のファイルなら、何もしない（対）', async () => {
    const box = await opened();
    const done = patch(box, { path: 'b.ts', from: 1, to: 1, text: 'const x = 1;', replacement: 'x' });
    assert.equal(done, false);
    assert.equal(box.area().value, 'const x = 1;\nconst y = 2;\n');
  });
});

/**
 * **ブラウザを閉じても、書いたものを失わない。**
 *
 * 預かりはパネルの中だけに在ったので、読み直すと消えていた。閉じる・押し間違えて
 * 再読み込み、で書いたものが消える（保存前なので、戻す先も無い）。覚えておく所へ
 * 預ける。ただし**中身が変わっていたら、黙って戻さない**（AI や別のブラウザが書いたものを、
 * 古い直しで上書きするため）。
 */
describe('保存していない直しは、ブラウザを閉じても残る', () => {
  /** 打って、手が止まるまで待つ（預けるのは手が止まってから）。 */
  async function typeInto(box: ReturnType<typeof open>, text: string) {
    box.area().value = text;
    box.area().oninput!();
    await new Promise((r) => setTimeout(r, 600));
  }

  test('**開き直すと、打ったものが戻る**', async () => {
    fresh();
    const disk = { 'a.ts': 'はじめ\n' };
    const first = open(disk, true);
    (first.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => first.area().value === 'はじめ\n', 'ファイルが開く');
    await typeInto(first, '書きかけ\n');

    // ブラウザを閉じて開き直した、と同じこと（パネルを閉じて作り直す）。
    first.close();
    const again = open(disk, true);
    (again.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => again.area().value === '書きかけ\n', '打ったものが戻る');
    assert.match(again.state().textContent, /保存していない直しを戻しました/, again.state().textContent);
  });

  test('**ファイルが変わっていたら、黙って戻さない**', async () => {
    fresh();
    const disk = { 'a.ts': 'はじめ\n' };
    const first = open(disk, true);
    (first.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => first.area().value === 'はじめ\n', 'ファイルが開く');
    await typeInto(first, '書きかけ\n');

    // その間に、AI か別のブラウザが書いた。
    disk['a.ts'] = 'AI が書いた\n';
    const again = open(disk, true);
    (again.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => again.area().value === 'AI が書いた\n', 'いまの中身が出る');
    const bar = again.find((n) => n.className.startsWith('editor-notice'));
    assert.equal(bar.hidden, false, '預かりが在ることを言っていない');
    assert.match(bar.text, /後から変わっています/, bar.text);
    // 出すかどうかは人が決める。押せば出る。
    again.press('その直しを出す');
    assert.equal(again.area().value, '書きかけ\n', '押しても出てこない');
  });

  test('保存したら、預かりは消える（対）', async () => {
    fresh();
    const disk = { 'a.ts': 'はじめ\n' };
    const first = open(disk, true);
    (first.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => first.area().value === 'はじめ\n', 'ファイルが開く');
    await typeInto(first, 'なおした\n');
    first.key('s');
    await until(() => disk['a.ts'] === 'なおした\n', '保存できる');
    await new Promise((r) => setTimeout(r, 600));

    const again = open(disk, true);
    (again.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => again.area().value === 'なおした\n', '開く');
    assert.doesNotMatch(again.state().textContent, /戻しました/, `保存したのに預かりが残っている: ${again.state().textContent}`);
  });

  test('大きすぎるものは預からない。そのことを言う（対）', async () => {
    fresh();
    const disk = { 'a.ts': 'はじめ\n' };
    const box = open(disk, true);
    (box.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => box.area().value === 'はじめ\n', 'ファイルが開く');
    await typeInto(box, 'あ'.repeat(600 * 1024));
    const bar = box.find((n) => n.className.startsWith('editor-notice'));
    // パネルを作り直しても消えることまで言う（「閉じると残りません」だけでは足りない）。
    assert.match(bar.text, /ブラウザを閉じたときも残りません/, bar.text);
    assert.match(bar.text, /パネルを作り直したとき/, bar.text);
    assert.equal(localStorage.getItem('aas.draft:a.ts'), null, '大きいのに預かっている');
  });
});

/**
 * 行末（CRLF）のファイル。
 *
 * **ブラウザの欄は、入れた `\r\n` を `\n` に直して持つ**（Chromium で実測）。
 * 開いた中身と欄の中身が最初から食い違うので、**一文字も触っていないのに
 * 「直しています」**になり、保存すると**全行が書き換わる**。配る先は Windows で、
 * CRLF のファイルは普通に在る。開いたときの形を覚えて、保存でその形に戻す。
 */
describe('CRLF のファイルを、勝手に書き換えない', () => {
  test('**開いただけでは、直したことにならない**', async () => {
    const disk = { 'a.txt': 'one\r\ntwo\r\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value.includes('one'), 'ファイルが開く');
    assert.equal(box.area().value, 'one\ntwo\n', '欄は行末をそろえて持つ');
    assert.match(box.state().textContent, /保存してあります/,
      `触っていないのに直したことになっている: ${box.state().textContent}`);
  });

  test('**保存すると、開いたときの行末で書き戻す**', async () => {
    const disk = { 'a.txt': 'one\r\ntwo\r\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value.includes('one'), 'ファイルが開く');
    box.area().value = 'one\nTWO\n';
    box.area().oninput!();
    box.key('s');
    await until(() => disk['a.txt'] !== 'one\r\ntwo\r\n', '保存できる');
    assert.equal(disk['a.txt'], 'one\r\nTWO\r\n', `行末が変わっている: ${JSON.stringify(disk['a.txt'])}`);
  });

  test('LF のファイルは、LF のまま（対）', async () => {
    const disk = { 'a.txt': 'one\ntwo\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value.includes('one'), 'ファイルが開く');
    box.area().value = 'one\nTWO\n';
    box.area().oninput!();
    box.key('s');
    await until(() => disk['a.txt'] === 'one\nTWO\n', '保存できる');
  });

  /**
   * **混ざっているものは、戻せない。だから、そう言う。**
   *
   * 欄は `\r\n` を `\n` に直して持つので、混ざったファイルは開いて保存するだけで
   * LF にそろう（触っていない行も変わる）。全部 CRLF のものは元へ戻せるが、
   * 混ざったものは戻せない。**黙って変えるのをやめて、開いた時点で言う。**
   */
  test('**混ざっているものは、LF にそろうと言う**', async () => {
    const disk = { 'a.txt': 'one\r\ntwo\nthree\r\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value.includes('one'), 'ファイルが開く');
    assert.match(box.at('editor-notice').text, /行末が混ざっています/,
      `混ざっていることを言っていない: ${box.at('editor-notice').text}`);

    box.area().value = 'one\ntwo\nTHREE\n';
    box.area().oninput!();
    box.key('s');
    await until(() => disk['a.txt'] !== 'one\r\ntwo\nthree\r\n', '保存できる');
    // 言ったとおり、LF にそろう（CRLF へ寄せ直しはしない）。
    assert.equal(disk['a.txt'], 'one\ntwo\nTHREE\n', `混ざっているのに CRLF へ寄せている: ${JSON.stringify(disk['a.txt'])}`);
  });

  test('混ざっていなければ、何も言わない（対）', async () => {
    const disk = { 'a.txt': 'one\r\ntwo\r\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value.includes('one'), 'ファイルが開く');
    assert.ok(!box.at('editor-notice').text.includes('行末が混ざっています'),
      `全部 CRLF なのに言っている: ${box.at('editor-notice').text}`);
  });

  /**
   * **保存したことを、補完の返事で消さない。**
   *
   * 打つと少しあとに続きを訊きに行く作りなので、打ってすぐ保存すると、保存が
   * 終わったあとに補完が走る。出す先が同じ一行なので「保存しました（+1 -1）」が
   * 「補完なし」へ化けていた（画面を押して実測）。**書けたのかが画面から消える。**
   *
   * **時計の速さに頼らない。**ここが頼るのは「先に予約したものが先に鳴る」だけ。
   * 補完の予約（打った時点）より後に置いた合図が鳴った時点では、補完はもう走って
   * いる。機械が混んでいれば両方が遅れるが、順番は変わらない。
   */
  test('**保存したあと、補完の返事で「保存しました」が消えない**', async () => {
    const disk = { 'a.ts': 'x\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => box.area().value === 'x\n', 'ファイルが開く');

    // 打つ。ここで補完の予約が入る（`addEventListener('input')` の側）。
    box.area().value = 'x1\n';
    box.area().setSelectionRange(3, 3);
    box.area().fire('input');
    box.key('s');
    await until(() => box.state().textContent.startsWith('保存しました'), '保存できる');

    let late = false;
    setTimeout(() => { late = true; }, 1500);
    await until(() => late, '補完が走る時刻を過ぎる', { timeoutMs: 10_000 });
    assert.match(box.state().textContent, /保存しました/,
      `保存の報せが消えている: ${box.state().textContent}`);
  });

  /**
   * **同じファイルを開き直して、書きかけを消さない。**
   *
   * 読み直しを飛ばすのは「直していないとき」だけだった。直している最中に
   * 同じファイルを開き直すと、ディスクの中身で欄を上書きしていた。
   * AI に `show_file` で開かせてから `replace_selection` で書き換えると、
   * 後から返ってくる読み直しが**当てた直しを消す**（画面を押して実測）。
   * 横の一覧で、開いているファイルをもう一度押したときも同じ道を通る。
   */
  test('**同じファイルを開き直しても、保存していない直しが消えない**', async () => {
    const disk = { 'a.ts': 'one\ntwo\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string, line?: number) => void)('a.ts');
    await until(() => box.area().value === 'one\ntwo\n', 'ファイルが開く');

    box.area().value = 'one\nTWO\n';
    box.area().fire('input');
    // 同じ所をもう一度開かせる（`show_file` も、横の一覧を押すのもここ）。
    (box.ctx.openFile as (p: string, line?: number) => void)('a.ts', 2);
    // 行を渡しているので、読み直しが終われば見出しに「2 行目」が出る。
    await until(() => box.state().textContent === '2 行目', '読み直しが終わる');
    assert.equal(box.area().value, 'one\nTWO\n', '書きかけが消えている');
  });

  /**
   * **直している最中に、ファイルの側が変わっていた。**黙って捨てない。
   * 自分の直しは預かって、押せば戻せる（AI が書き換えたときと同じ扱い）。
   */
  test('**開き直したときファイルが変わっていたら、直しを預かってから出す**', async () => {
    const disk = { 'a.ts': 'one\ntwo\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string, line?: number) => void)('a.ts');
    await until(() => box.area().value === 'one\ntwo\n', 'ファイルが開く');

    box.area().value = 'one\nMINE\n';
    box.area().fire('input');
    disk['a.ts'] = 'one\nAI\n';
    (box.ctx.openFile as (p: string, line?: number) => void)('a.ts');
    await until(() => box.area().value === 'one\nAI\n', 'いまのファイルが出る');
    box.press('自分の直しに戻す');
    assert.equal(box.area().value, 'one\nMINE\n', '預かった直しに戻れない');
  });

  /**
   * **打つたびに、行番号を全部書き直さない。**
   *
   * ここは一文字ごとに 1 から行数まで数字を繋ぎ直して、丸ごと入れ直していた。
   * 行が増えるほど遅くなり、実測で 5000 行のファイルは一打 35ms、40000 行では
   * 254ms かかっていた（本物のブラウザで、一文字ずつ入れて測った）。
   * 書いた字が遅れて出る。
   *
   * **速さそのものは試験にしない**（走らせる機械で変わる）。代わりに
   * 「行の数が変わらなければ書き直さない」を見る。
   */
  test('**行が増えなければ、行番号は書き直さない**', async () => {
    const disk = { 'a.ts': 'one\ntwo\nthree\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => box.area().value.includes('two'), 'ファイルが開く');

    const gutter = box.at('editor-lines');
    let writes = 0;
    let held = gutter.textContent;
    Object.defineProperty(gutter, 'textContent', {
      configurable: true,
      get: () => held,
      set: (v: string) => { writes += 1; held = v; },
    });

    // 行の中に打つ（行は増えない）。
    box.area().value = 'oneX\ntwo\nthree\n';
    box.area().fire('input');
    assert.equal(writes, 0, '行が増えていないのに、行番号を書き直している');

    // 行が増えたら、足りない分が付く。
    box.area().value = 'oneX\ntwo\nthree\nfour\n';
    box.area().fire('input');
    assert.equal(writes, 1, '行が増えたのに、行番号が追いついていない');
    assert.equal(held, '1\n2\n3\n4\n5\n', `行番号がおかしい: ${JSON.stringify(held)}`);

    // 行が減ったら、数え直す。
    box.area().value = 'oneX\n';
    box.area().fire('input');
    assert.equal(held, '1\n2\n', `減ったときに合っていない: ${JSON.stringify(held)}`);
  });

  /**
   * **自分の保存で「AI が書き換えました」と出さない。**
   *
   * 本体は書けた時点で差分を全員へ配る。その写しが**返事より先に戻ってくる**ので、
   * まだ `loaded` を入れ替える前の欄は「直している最中」のままになり、
   * 保存するたびに「AI がこのファイルを書き換えました」と出ていた（押して実測）。
   * 自分で保存しただけなのに、身に覚えのない書き換えを知らされる。
   */
  test('**自分の保存の写しでは、書き換えられたと言わない**', async () => {
    const disk = { 'a.ts': 'one\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => box.area().value === 'one\n', 'ファイルが開く');

    // 保存の返事を、こちらが放すまで返さない形にする。
    const inner = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'PUT') await gate;
      return (inner as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    box.area().value = 'one\nTWO\n';
    box.area().fire('input');
    box.key('s');
    // 返事より先に、自分の書き込みの写しが戻ってくる。
    box.emit('session', { type: 'diff', path: 'a.ts', diff: '', added: 1, removed: 0 });
    assert.ok(!box.at('editor-notice').text.includes('AI がこのファイルを書き換えました'),
      `自分の保存で、書き換えられたと言っている: ${box.at('editor-notice').text}`);

    release();
    await until(() => box.state().textContent.startsWith('保存しました'), '保存できる');
    (globalThis as { fetch?: unknown }).fetch = inner;
  });

  test('よそからの書き換えなら、ちゃんと言う（対）', async () => {
    const disk = { 'a.ts': 'one\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => box.area().value === 'one\n', 'ファイルが開く');
    box.area().value = 'one\nMINE\n';
    box.area().fire('input');
    box.emit('session', { type: 'diff', path: 'a.ts', diff: '', added: 1, removed: 0 });
    assert.match(box.at('editor-notice').text, /AI がこのファイルを書き換えました/,
      `よそからの書き換えを言っていない: ${box.at('editor-notice').text}`);
  });

  /**
   * **「AI の版を出す」でも、行末をそろえてから取り込む。**
   *
   * 生のまま `loaded` に入れていたので、欄（`\n` にそろえて持つ）と食い違い、
   * 押した直後から**一文字も触っていないのに「直しています」**のまま戻らなかった。
   */
  test('**AI の版を出しても、直したことにならない（CRLF）**', async () => {
    const disk = { 'a.txt': 'one\r\ntwo\r\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value.includes('one'), 'ファイルが開く');

    box.area().value = 'one\nMINE\n';
    box.area().fire('input');
    // よそが書き換えた（中身も CRLF のまま）。
    disk['a.txt'] = 'one\r\nAI\r\n';
    box.emit('session', { type: 'diff', path: 'a.txt', diff: '', added: 1, removed: 0 });
    box.press('AI の版を出す');
    await until(() => box.area().value === 'one\nAI\n', 'AI の版が出る');
    assert.match(box.state().textContent, /保存してあります/,
      `触っていないのに直したことになっている: ${box.state().textContent}`);
  });

  /**
   * **保存している間に、別のファイルへ移ることがある。**
   *
   * 返事を読んだところで今の `path` を見ていたので、移った先へ前のファイルの
   * 結果を当てていた（移った先を「保存してあります」にして、預かりを捨てる）。
   * 移った先の書きかけが、次の読み直しで消える。
   */
  test('**保存の途中で別のファイルへ移っても、移った先を書き換えない**', async () => {
    const disk = { 'a.txt': 'A\n', 'b.txt': 'B\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value === 'A\n', 'a が開く');

    // 保存の返事を、こちらが放すまで返さない。
    const inner = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'PUT') await gate;
      return (inner as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    box.area().value = 'A2\n';
    box.area().fire('input');
    box.key('s');
    // 返事を待たずに、別のファイルへ移って打つ。
    (box.ctx.openFile as (p: string) => void)('b.txt');
    await until(() => box.area().value === 'B\n', 'b が開く');
    box.area().value = 'B2\n';
    box.area().fire('input');

    release();
    await until(() => disk['a.txt'] === 'A2\n', 'a が保存される');
    assert.equal(box.area().value, 'B2\n', '移った先の中身が変わっている');
    assert.match(box.state().textContent, /直しています/,
      `移った先を「保存した」ことにしている: ${box.state().textContent}`);
    (globalThis as { fetch?: unknown }).fetch = inner;
  });

  /**
   * **預かった直しを、読み直しで捨てない。**
   *
   * 「AI の版を出す」を押すと、自分の直しは預かりの中だけに残る。そこへもう一度
   * 書き換えが来ると、読み直しで預かりごと捨てていたので、戻す先が無くなっていた。
   */
  test('**二度書き換えられても、預かった直しに戻せる**', async () => {
    const disk = { 'a.txt': 'one\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value === 'one\n', 'ファイルが開く');

    box.area().value = 'one\nMINE\n';
    box.area().fire('input');
    disk['a.txt'] = 'one\nAI\n';
    box.emit('session', { type: 'diff', path: 'a.txt', diff: '', added: 1, removed: 0 });
    box.press('AI の版を出す');
    await until(() => box.area().value === 'one\nAI\n', 'AI の版が出る');

    // 二度目の書き換え。直していないので、そのまま読み直す。
    disk['a.txt'] = 'one\nAI2\n';
    box.emit('session', { type: 'diff', path: 'a.txt', diff: '', added: 1, removed: 0 });
    await until(() => box.area().value === 'one\nAI2\n', '二度目が出る');
    box.press('自分の直しに戻す');
    assert.equal(box.area().value, 'one\nMINE\n', '預かった直しに戻れない');
  });

  /**
   * **保存の間に打った字が、黙って消える。**
   *
   * PUT の本体はそのときの中身を写して送る。返事のあと「保存した中身」を
   * **いまの欄**にしていたので、返事を待つ間（最大 20 秒）に打った分まで
   * 保存済みになった。押し場所は灰色、預かりも消える。**画面とディスクが
   * 違うまま、読み直しでその分を失う。**
   */
  test('**保存の返事を待つ間に打った分を、保存したことにしない**', async () => {
    const disk = { 'typed-while-saving.txt': 'one\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('typed-while-saving.txt');
    await until(() => box.area().value === 'one\n', 'ファイルが開く');

    const inner = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'PUT') await gate;
      return (inner as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    box.area().value = 'one\ntwo\n';
    box.area().fire('input');
    box.key('s');
    // 返事を待つ間に、続きを打つ。
    box.area().value = 'one\ntwo\nthree\n';
    box.area().fire('input');
    release();

    await until(() => disk['typed-while-saving.txt'] === 'one\ntwo\n', '送った分が保存される');
    await until(() => box.state().textContent.includes('保存しました'), '保存の返事が出る');
    assert.match(box.state().textContent, /まだ保存していません/,
      `保存の間に打った分を、保存したことにしている: ${box.state().textContent}`);
    const kept = localStorage.getItem('aas.draft:typed-while-saving.txt');
    assert.ok(kept && kept.includes('three'), '保存の間に打った分の預かりを消している');
    (globalThis as { fetch?: unknown }).fetch = inner;
  });

  /**
   * **「AI の版を出す」あと、別のファイルへ移ると自分の直しが消えていた。**
   *
   * 預かりは一つの変数だけに在り、欄は AI の版と同じ＝`dirty()` は false なので、
   * 離れるときの預かりも走らない。別のファイルを開いた瞬間に、戻す口ごと消える。
   */
  test('**AI の版を出したあと別のファイルへ移っても、自分の直しに戻せる**', async () => {
    const disk = { 'a.txt': 'one\n', 'b.txt': 'B\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value === 'one\n', 'a が開く');

    box.area().value = 'one\nMINE\n';
    box.area().fire('input');
    disk['a.txt'] = 'one\nAI\n';
    box.emit('session', { type: 'diff', path: 'a.txt', diff: '', added: 1, removed: 0 });
    box.press('AI の版を出す');
    await until(() => box.area().value === 'one\nAI\n', 'AI の版が出る');

    (box.ctx.openFile as (p: string) => void)('b.txt');
    await until(() => box.area().value === 'B\n', 'b が開く');
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value === 'one\nAI\n', 'a へ戻る');

    box.press('自分の直しに戻す');
    assert.equal(box.area().value, 'one\nMINE\n', '別のファイルを経ると預かった直しが消えている');
  });

  /**
   * **CRLF のファイルが、開き直しで全行 LF になる。**
   *
   * 直している最中に同じファイルを開き直す所（一覧を押す・探した結果から飛ぶ）で、
   * 行末をそろえた後の中身を渡していた。渡した先は渡されたものから行末を見直すので、
   * `\r\n` が消えた中身では `\n` に戻る。次の保存が、触っていない行まで書き換える。
   */
  test('**CRLF のファイルは、直している最中に開き直しても CRLF で保存する**', async () => {
    const disk = { 'a.txt': 'one\r\ntwo\r\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value === 'one\ntwo\n', 'ファイルが開く');

    box.area().value = 'one\ntwo\nMINE\n';
    box.area().fire('input');
    // ファイルの側が変わってから、同じファイルを開き直す。
    disk['a.txt'] = 'one\r\nX\r\n';
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value === 'one\nX\n', '開き直す');

    box.area().value = 'one\nX2\n';
    box.area().fire('input');
    box.key('s');
    await until(() => disk['a.txt'] !== 'one\r\nX\r\n', '保存される');
    assert.equal(disk['a.txt'], 'one\r\nX2\r\n', `行末が LF にそろっている: ${JSON.stringify(disk['a.txt'])}`);
  });

  /**
   * **開き直せなかったときに、直している欄を空にしない。**
   *
   * 開いているファイルが消えた・名前が変わった（404）状態で同じ名前を押すと、
   * 欄を空にしていた。開けないので預かりも出せず、保存していない直しがどこにも
   * 残らない。
   */
  test('**開き直せなくても、保存していない直しを欄から消さない**', async () => {
    const disk: Record<string, string> = { 'gone-while-editing.txt': 'one\n' };
    // 名前を他の試験と分ける。前の試験のパネルは、終わった後にも保存の返事を受けて同じ名前の預かりを消すことがある
    // （預かる所はみんなで一つ）。重なると、ここが偶然落ちる（check の中で一度落ちた）。
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('gone-while-editing.txt');
    await until(() => box.area().value === 'one\n', 'ファイルが開く');

    box.area().value = 'one\nMINE\n';
    box.area().fire('input');
    delete disk['gone-while-editing.txt'];
    (box.ctx.openFile as (p: string) => void)('gone-while-editing.txt');
    await until(() => box.at('editor-notice').hidden === false, '開けなかったことを言う');
    assert.equal(box.area().value, 'one\nMINE\n', '開けなかっただけで、直しを欄から消している');
    assert.match(box.at('editor-notice').text, /残してあります/, '残してあることを言っていない');
    const kept = localStorage.getItem('aas.draft:gone-while-editing.txt');
    assert.ok(kept && kept.includes('MINE'), '開けなかったときに預かっていない');
  });

  /**
   * **保存できなかったことを、別のファイルへ移っても言う。**
   *
   * Ctrl+S の直後に別のファイルを押すと、409（`いま作業中です`）や 500 を
   * 丸ごと捨てていた。帯も一行も出ないので、保存できていないことに気づけない。
   */
  test('**移ったあとでも、保存できなかったことを言う**', async () => {
    const disk = { 'a.txt': 'A\n', 'b.txt': 'B\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value === 'A\n', 'a が開く');

    const inner = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'PUT') { await gate; return Response.json({ error: 'いま作業中です' }, { status: 409 }); }
      return (inner as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    box.area().value = 'A2\n';
    box.area().fire('input');
    box.key('s');
    (box.ctx.openFile as (p: string) => void)('b.txt');
    await until(() => box.area().value === 'B\n', 'b が開く');
    release();

    await until(() => box.at('editor-notice').hidden === false, '保存できなかったことを言う');
    assert.match(box.at('editor-notice').text, /a\.txt/, 'どのファイルが保存できなかったのか言っていない');
    assert.match(box.at('editor-notice').text, /保存できませんでした/, '保存できなかったことを言っていない');
    (globalThis as { fetch?: unknown }).fetch = inner;
  });

  /**
   * **灰色（補完）は、見えていた所と違う所へ入れない。**
   *
   * 灰色が出たままカーソルキーで動かして Tab を押すと、いまのカーソルへ差し込んでいた。
   * 字下げのつもりで押した人が、見ていない所に知らない字を入れることになる。
   */
  describe('補完の灰色', () => {
    /** 補完が「SUGGEST」を返す形にして、灰色を出す。 */
    const withGhost = async () => {
      const disk = { 'a.txt': 'one\n' };
      const box = open(disk);
      const inner = globalThis.fetch;
      (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: { method?: string }) => {
        if (String(url).includes('/api/complete')) return Response.json({ text: 'SUGGEST' });
        return (inner as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init);
      }) as unknown as typeof fetch;
      (box.ctx.openFile as (p: string) => void)('a.txt');
      await until(() => box.area().value === 'one\n', 'ファイルが開く');
      box.area().setSelectionRange(4, 4);
      box.key(' ');
      await until(() => box.state().textContent.includes('Tab で入れる'), '灰色が出る');
      return { box, inner };
    };

    test('**カーソルを動かしたあとの Tab は、字下げになる**', async () => {
      const { box, inner } = await withGhost();
      box.area().setSelectionRange(0, 0);
      box.key('Tab', { ctrlKey: false });
      assert.equal(box.area().value, '  one\n',
        `見えていない所へ補完を入れている: ${JSON.stringify(box.area().value)}`);
      (globalThis as { fetch?: unknown }).fetch = inner;
    });

    test('動かしていなければ、Tab で入る（対）', async () => {
      const { box, inner } = await withGhost();
      box.key('Tab', { ctrlKey: false });
      assert.equal(box.area().value, 'one\nSUGGEST', `Tab で入らない: ${JSON.stringify(box.area().value)}`);
      (globalThis as { fetch?: unknown }).fetch = inner;
    });

    test('カーソルキーで動かしたら、灰色は消える', async () => {
      const { box, inner } = await withGhost();
      assert.match(box.at('editor-ghost').text, /SUGGEST/, '灰色が出ていない');
      box.key('ArrowUp', { ctrlKey: false });
      assert.equal(box.at('editor-ghost').text, '', 'カーソルキーで動かしても灰色が残っている');
      (globalThis as { fetch?: unknown }).fetch = inner;
    });
  });

  /**
   * **全部置き換えを、Ctrl+Z で戻せる形にする。**
   *
   * 丸ごと代入していたので、ブラウザの戻し履歴が消えていた。押した人は置換の
   * 前に戻せない。
   *
   * 戻せるかどうかはブラウザの中に在るので、ここで見えるのは**一度の書き換えで
   * 入れ替えていること**だけ（ここの `document` には `execCommand` が無いので、
   * `writeRange` は `setRangeText` に落ちる）。本物のブラウザで Ctrl+Z を押して
   * 戻ることは `scripts/sweep.mjs` で見ている。
   */
  test('**全部置き換えは、一度の書き換えで入れ替える（戻せる形）**', async () => {
    const disk = { 'a.ts': 'const a = 1;\nconst b = 2;\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => box.area().value.includes('const'), 'ファイルが開く');

    const area = box.area();
    const real = area.setRangeText.bind(area);
    const calls: Array<{ from: number; to: number }> = [];
    area.setRangeText = ((text: string, from: number, to: number, mode?: 'select' | 'start' | 'end' | 'preserve') => {
      calls.push({ from, to });
      real(text, from, to, mode);
    }) as typeof area.setRangeText;

    box.key('f');
    box.at('find-q').value = 'const';
    box.at('find-q').fire('input');
    box.at('find-r').value = 'let';
    box.press('全部');

    assert.equal(box.area().value, 'let a = 1;\nlet b = 2;\n', '置き換わっていない');
    assert.equal(calls.length, 1, `丸ごと代入している（戻し履歴が消える）: ${calls.length} 回`);
    assert.deepEqual(calls[0], { from: 0, to: 'const a = 1;\nconst b = 2;\n'.length });
  });

  /**
   * **AI の書き込みで、打っている手を奪わない。**
   *
   * 読み直しは最後に必ず欄へ手を移していた。チャットの欄に打っている途中で
   * AI がそのファイルを書くと、続きがファイルの欄に入る。
   */
  test('**AI の書き込みで読み直すときは、欄へ手を移さない**', async () => {
    /*
     * 名前を他の試験と分ける。前の試験（「AI の版を出したあと別のファイルへ移っても」）のパネルは、終わった 400ms 後に
     * `a.txt` の直し（中身 MINE・base が AI の版）を預かる所へ書く。その時刻にこの試験が当たると、読み直しが
     * それを「閉じたパネルの直し」として引き取り、AI の版の代わりに MINE を出す（Windows の CI で 30 秒待って落ちた）。
     */
    const disk = { 'ai-write-keeps-focus.txt': 'one\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('ai-write-keeps-focus.txt');
    await until(() => box.area().value === 'one\n', 'ファイルが開く');

    let moved = 0;
    box.area().focus = () => { moved += 1; };
    disk['ai-write-keeps-focus.txt'] = 'one\nAI\n';
    box.emit('session', { type: 'diff', path: 'ai-write-keeps-focus.txt', diff: '', added: 1, removed: 0 });
    await until(() => box.area().value === 'one\nAI\n', 'AI の版が出る');
    assert.equal(moved, 0, 'AI の書き込みで、打っている手を奪っている');

    // 人が押して開いたときは、これまでどおり手を移す（対）。
    (box.ctx.openFile as (p: string, line?: number) => void)('ai-write-keeps-focus.txt');
    disk['ai-write-keeps-focus.txt'] = 'one\nAI2\n';
    (box.ctx.openFile as (p: string, line?: number) => void)('ai-write-keeps-focus.txt');
    await until(() => box.area().value === 'one\nAI2\n', '押して開き直す');
    assert.ok(moved > 0, '人が押して開いても、手が移らない');
  });

  test('行番号に数字でないものを入れて Enter を押したら、そう言う', async () => {
    const disk = { 'a.txt': 'one\ntwo\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value === 'one\ntwo\n', 'ファイルが開く');
    box.key('g');
    const line = box.at('find-line');
    line.value = 'あ';
    line.onkeydown!({ key: 'Enter', preventDefault: () => undefined });
    assert.match(box.state().textContent, /数字/, `押して何も起きない: ${box.state().textContent}`);
  });

  /**
   * **AI の直しが入らなかったことを、帯だけに頼らない。**
   *
   * 入らなかった知らせは `info` なので、消えるものが在る知らせが出ていると
   * 押しのけない＝完全に無音になる。一行の所にも出す。
   */
  test('**割れている帯が出ていても、AI の直しが入らなかったことは出る**', async () => {
    const disk = { 'a.txt': 'one\ntwo\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value === 'one\ntwo\n', 'ファイルが開く');

    // 直している最中に AI が書いて、割れている帯を出す。
    box.area().value = 'one\ntwo\nMINE\n';
    box.area().fire('input');
    disk['a.txt'] = 'one\nAI\n';
    box.emit('session', { type: 'diff', path: 'a.txt', diff: '', added: 1, removed: 0 });
    await until(() => box.at('editor-notice').text.includes('書き換えました'), '割れている帯が出る');

    const ok = (box.ctx.applyPatch as (at: unknown) => boolean)({
      path: 'a.txt', from: 1, to: 1, text: 'どこにも無い', replacement: 'X',
    });
    assert.equal(ok, false, '当たっていないのに入れている');
    assert.match(box.state().textContent, /入れられませんでした/,
      `入らなかったことが、どこにも出ていない: ${box.state().textContent}`);
  });
});

describe('二つのパネルで同じファイルを開く', () => {
  /**
   * **保存した側が、もう一方の保存していない直しの預かりを消さない。**
   *
   * 預かる所はファイルの名前ごとに一つで、パネルをまたいで同じ。保存した側と、直しが無くなった側の片づけは、
   * 誰が預けたものかを見ずに消していた。もう一方のパネル（別のタブも同じ）がブラウザごと閉じると、直しが残らない。
   */
  test('**保存した側の片づけが、もう一方の預かりを消さない**', async () => {
    const disk: Record<string, string> = { 'two-panels.txt': 'one\n' };
    const a = open(disk);
    const b = open(disk, true);
    (a.ctx.openFile as (p: string) => void)('two-panels.txt');
    (b.ctx.openFile as (p: string) => void)('two-panels.txt');
    await until(() => a.area().value === 'one\n' && b.area().value === 'one\n', '両方で開く');

    a.area().value = 'one\nA\n';
    a.area().fire('input');
    await until(() => (localStorage.getItem('aas.draft:two-panels.txt') ?? '').includes('A'), 'A が預ける');

    // B の片づけがこの預かりを読んだ回数を数える（保存の後の片づけと、打ったときの時計の片づけの二回）。
    const realGet = localStorage.getItem.bind(localStorage);
    let reads = 0;
    (localStorage as { getItem: unknown }).getItem = (k: string) => {
      if (k === 'aas.draft:two-panels.txt') reads += 1;
      return realGet(k);
    };
    try {
      b.area().value = 'one\nB\n';
      b.area().fire('input');
      b.key('s');
      await until(() => disk['two-panels.txt'] === 'one\nB\n', 'B が保存する');
      await until(() => b.state().textContent.includes('保存しました'), 'B の保存の返事が出る');
      await until(() => reads >= 2, 'B の片づけが二回とも走る');
    } finally {
      (localStorage as { getItem: unknown }).getItem = realGet;
    }
    const kept = localStorage.getItem('aas.draft:two-panels.txt');
    assert.equal(kept && (JSON.parse(kept) as { text: string }).text, 'one\nA\n', `B の片づけが A の預かりを消した: ${kept}`);
  });

  test('**ブラウザを閉じた後の古い預かりは、「後から変わっています」を出したら片づける（開くたびに出し続けない）**', async () => {
    const disk: Record<string, string> = { 'stale.txt': 'NEW\n' };
    fresh();
    localStorage.setItem('aas.draft:stale.txt', JSON.stringify({ text: 'OLD-EDIT\n', base: 'OLD\n', at: Date.now(), by: 'closed-panel' }));
    const a = open(disk, true);
    (a.ctx.openFile as (p: string) => void)('stale.txt');
    await until(() => a.at('editor-notice').hidden === false, '後から変わっていると言う');
    await until(() => localStorage.getItem('aas.draft:stale.txt') === null, '知らせた古い預かりを片づけない');
    const b = open(disk, true);
    (b.ctx.openFile as (p: string) => void)('stale.txt');
    await until(() => b.area().value === 'NEW\n', '開く');
    assert.equal(b.at('editor-notice').hidden, true, '同じ知らせをもう一度出した');
  });

  test('**生きている別のパネルの預かりは、後から開いた側が引き取らない**（保存した版を出し、そう言う）', async () => {
    fresh();
    const disk: Record<string, string> = { 'live.txt': 'one\n' };
    const a = open(disk, true);
    (a.ctx.openFile as (p: string) => void)('live.txt');
    await until(() => a.area().value === 'one\n', 'A で開く');
    a.area().value = 'one\nA\n';
    a.area().fire('input');
    await until(() => (localStorage.getItem('aas.draft:live.txt') ?? '').includes('A'), 'A が預ける');
    const byA = (JSON.parse(localStorage.getItem('aas.draft:live.txt')!) as { by: string }).by;

    const b = open(disk, true);
    (b.ctx.openFile as (p: string) => void)('live.txt');
    const bar = () => b.find((n) => n.className.startsWith('editor-notice'));
    await until(() => bar().hidden === false, '別のパネルで直している途中だと言う');
    assert.equal(b.area().value, 'one\n', '生きている別のパネルの直しを引き取った');
    assert.match(bar().text, /別のパネル/, bar().text);
    assert.equal((JSON.parse(localStorage.getItem('aas.draft:live.txt')!) as { by: string }).by, byA, '預かりの名札を奪った');
  });

  test('**別のタブのパネルは時刻で見る**: 新しければ引き取らず、古ければ（閉じた）引き取る', async () => {
    for (const [ago, adopt] of [[100_000, false], [300_000, true]] as const) {
      fresh();
      const disk: Record<string, string> = { 'tab.txt': 'one\n' };
      localStorage.setItem('aas.draft:tab.txt', JSON.stringify({ text: 'one\nT\n', base: 'one\n', at: Date.now(), by: 'other-tab' }));
      localStorage.setItem('aas.live:other-tab', String(Date.now() - ago));
      const b = open(disk, true);
      (b.ctx.openFile as (p: string) => void)('tab.txt');
      await until(() => b.area().value !== '', '開く');
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(b.area().value, adopt ? 'one\nT\n' : 'one\n', `${ago}ms 前の合図で、引き取り方が違う`);
    }
  });

  test('**タブで隠れて外れていても、並びの世代が同じなら生きている。組み直したら（世代が変わったら）引き取る**', async () => {
    fresh();
    let gen = 1;
    const disk: Record<string, string> = { 'tabbed.txt': 'one\n' };
    const a = open(disk, true, { gen: () => gen });
    (a.ctx.openFile as (p: string) => void)('tabbed.txt');
    await until(() => a.area().value === 'one\n', 'A で開く');
    a.area().value = 'one\nA\n';
    a.area().fire('input');
    await until(() => (localStorage.getItem('aas.draft:tabbed.txt') ?? '').includes('A'), 'A が預ける');
    a.close(); // タブを切り替えて DOM から外れた（まだ生きている）

    const b = open(disk, true, { gen: () => gen });
    (b.ctx.openFile as (p: string) => void)('tabbed.txt');
    await until(() => b.state().textContent === '別のパネルで直している途中', '隠れているだけのパネルを生きていると見る');
    assert.equal(b.area().value, 'one\n', '隠れているだけのパネルの直しを引き取った');

    gen += 1; // 並びを組み直した。A も B も捨てられた
    const c = open(disk, true, { gen: () => gen });
    (c.ctx.openFile as (p: string) => void)('tabbed.txt');
    await until(() => c.area().value === 'one\nA\n', '捨てられたパネルの直しは引き取る');
  });

  test('**捨てられたら、ページに付けた受け手を外す**（外さないと、捨てたエディタが中身ごと残る）', async () => {
    const listeners = new Map<string, Set<unknown>>();
    const g = globalThis as { addEventListener?: unknown; removeEventListener?: unknown };
    const saved = [g.addEventListener, g.removeEventListener];
    g.addEventListener = (t: string, fn: unknown) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(fn); };
    g.removeEventListener = (t: string, fn: unknown) => { listeners.get(t)?.delete(fn); };
    try {
      fresh();
      let gen = 1;
      open({}, true, { gen: () => gen });
      assert.equal(listeners.get('pagehide')?.size, 1);
      gen += 1;
      await until(() => (listeners.get('pagehide')?.size ?? 0) === 0 && (listeners.get('pageshow')?.size ?? 0) === 0,
        '捨てられたのに受け手を外していない', { timeoutMs: 8_000 });
    } finally {
      [g.addEventListener, g.removeEventListener] = saved;
    }
  });

  test('**引き取らなかった側で打っても、生きている別のパネルの預かりを上書きしない（そう言う）**', async () => {
    fresh();
    const disk: Record<string, string> = { 'busy.txt': 'one\n' };
    const a = open(disk, true);
    (a.ctx.openFile as (p: string) => void)('busy.txt');
    await until(() => a.area().value === 'one\n', 'A で開く');
    a.area().value = 'one\nA\n';
    a.area().fire('input');
    await until(() => (localStorage.getItem('aas.draft:busy.txt') ?? '').includes('A'), 'A が預ける');

    const b = open(disk, true);
    (b.ctx.openFile as (p: string) => void)('busy.txt');
    await until(() => b.state().textContent === '別のパネルで直している途中', 'B は引き取らない');
    b.area().value = 'one\nB\n';
    b.area().fire('input');
    const bar = () => b.find((n) => n.className.startsWith('editor-notice'));
    await until(() => /預かれません/.test(bar().text), 'B の直しを預かれないと言う');
    assert.equal((JSON.parse(localStorage.getItem('aas.draft:busy.txt')!) as { text: string }).text, 'one\nA\n', 'A の預かりを上書きした');
  });

  test('**行末が混ざったファイルでも、なぜ直しが戻らないかを見出しに残す**（後の知らせに置き換わっても）', async () => {
    fresh();
    const disk: Record<string, string> = { 'mixed.txt': 'one\r\ntwo\n' };
    const a = open(disk, true);
    (a.ctx.openFile as (p: string) => void)('mixed.txt');
    await until(() => a.area().value !== '', 'A で開く');
    a.area().value = a.area().value + 'A\n';
    a.area().fire('input');
    await until(() => (localStorage.getItem('aas.draft:mixed.txt') ?? '').includes('A'), 'A が預ける');
    const b = open(disk, true);
    (b.ctx.openFile as (p: string) => void)('mixed.txt');
    await until(() => /行末が混ざって/.test(b.find((n) => n.className.startsWith('editor-notice')).text), '行末の知らせが出る');
    assert.equal(b.state().textContent, '別のパネルで直している途中');
  });

  test('名札の無い預かり（前の版が預けた）は、保存したら片づける', async () => {
    const disk: Record<string, string> = { 'legacy.txt': 'one\n' };
    const a = open(disk);
    (a.ctx.openFile as (p: string) => void)('legacy.txt');
    await until(() => a.area().value === 'one\n', '開く');
    localStorage.setItem('aas.draft:legacy.txt', JSON.stringify({ text: 'one\nX\n', base: 'one\n', at: Date.now() }));
    a.area().value = 'one\nA\n';
    a.area().fire('input');
    a.key('s');
    await until(() => disk['legacy.txt'] === 'one\nA\n', '保存する');
    await until(() => localStorage.getItem('aas.draft:legacy.txt') === null, '名札の無い預かりが残っている');
  });

  test('他のパネルの預かりでも、中身が保存した版と同じなら片づける', async () => {
    const disk: Record<string, string> = { 'same.txt': 'one\n' };
    const a = open(disk);
    (a.ctx.openFile as (p: string) => void)('same.txt');
    await until(() => a.area().value === 'one\n', '開く');
    localStorage.setItem('aas.draft:same.txt', JSON.stringify({ text: 'one\nA\n', base: 'one\n', at: Date.now(), by: 'other' }));
    a.area().value = 'one\nA\n';
    a.area().fire('input');
    a.key('s');
    await until(() => disk['same.txt'] === 'one\nA\n', '保存する');
    await until(() => localStorage.getItem('aas.draft:same.txt') === null, '保存した版と同じ預かりが残っている');
  });

  test('「その直しを出す」で出した直しは、出した側のものになり、手を入れてすぐ保存しても片づける', async () => {
    const disk: Record<string, string> = { 'shown.txt': 'NEW\n' };
    fresh();
    localStorage.setItem('aas.draft:shown.txt', JSON.stringify({ text: 'OLD-EDIT\n', base: 'OLD\n', at: Date.now(), by: 'closed-panel' }));
    const a = open(disk, true);
    (a.ctx.openFile as (p: string) => void)('shown.txt');
    await until(() => a.at('editor-notice').hidden === false, '後から変わっていると言う');
    a.press('その直しを出す');
    a.area().value = 'OLD-EDIT2\n';
    a.area().fire('input');
    a.key('s');
    await until(() => disk['shown.txt'] === 'OLD-EDIT2\n', '保存する');
    await until(() => localStorage.getItem('aas.draft:shown.txt') === null, '出して保存したのに預かりが残っている');
  });

  test('大きすぎて預けられなくなったら、前に預けた小さい版を残さない', async () => {
    const disk: Record<string, string> = { 'big.txt': 'one\n' };
    const a = open(disk);
    (a.ctx.openFile as (p: string) => void)('big.txt');
    await until(() => a.area().value === 'one\n', '開く');
    a.area().value = 'one\nsmall\n';
    a.area().fire('input');
    await until(() => localStorage.getItem('aas.draft:big.txt') !== null, '小さい版を預ける');
    a.area().value = `one\n${'x'.repeat(600 * 1024)}\n`;
    a.area().fire('input');
    await until(() => localStorage.getItem('aas.draft:big.txt') === null, '古い小さい版が残っている');
  });

  test('自分で預けた分は、保存したら片づける（対）', async () => {
    const disk: Record<string, string> = { 'one-panel.txt': 'one\n' };
    const a = open(disk);
    (a.ctx.openFile as (p: string) => void)('one-panel.txt');
    await until(() => a.area().value === 'one\n', '開く');
    a.area().value = 'one\nA\n';
    a.area().fire('input');
    await until(() => localStorage.getItem('aas.draft:one-panel.txt') !== null, '預ける');
    a.key('s');
    await until(() => disk['one-panel.txt'] === 'one\nA\n', '保存する');
    await until(() => localStorage.getItem('aas.draft:one-panel.txt') === null, '保存しても預かりが残っている');
  });

  test('覚えておく所から戻した直しは、戻した側のものになり、保存したら片づける', async () => {
    const disk: Record<string, string> = { 'adopted.txt': 'one\n' };
    fresh();
    localStorage.setItem('aas.draft:adopted.txt', JSON.stringify({ text: 'one\nOLD\n', base: 'one\n', at: Date.now(), by: 'someone-else' }));
    const a = open(disk, true);
    (a.ctx.openFile as (p: string) => void)('adopted.txt');
    await until(() => a.area().value === 'one\nOLD\n', '預かりが戻る');
    // 戻したものに手を入れて、預かりの時計（400 ms）より先に保存する（預かりの中身と欄が違う形）。
    a.area().value = 'one\nOLD2\n';
    a.area().fire('input');
    a.key('s');
    await until(() => disk['adopted.txt'] === 'one\nOLD2\n', '保存する');
    await until(() => localStorage.getItem('aas.draft:adopted.txt') === null, '戻して保存したのに預かりが残っている');
  });
});

describe('別のファイルへ移って戻る', () => {
  /**
   * **離れている間にファイルが変わっていたら、預けた直しを黙って戻さない。**
   *
   * 戻ったときに黙って直しを戻していた。開き直しで新しい stamp を取るので、次の保存は「開いたあとで変わった」を
   * 確かめられず、離れている間の AI や別のパネルの書き換えを消していた。
   */
  test('**離れている間に変わっていたら、新しい中身を出し、直しは「出す」を押したときだけ戻す**', async () => {
    const disk: Record<string, string> = { 'moved-a.txt': 'one\n', 'moved-b.txt': 'B\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('moved-a.txt');
    await until(() => box.area().value === 'one\n', 'a が開く');
    box.area().value = 'one\nMINE\n';
    box.area().fire('input');
    (box.ctx.openFile as (p: string) => void)('moved-b.txt');
    await until(() => box.area().value === 'B\n', 'b が開く');
    disk['moved-a.txt'] = 'one\nAI\n';
    (box.ctx.openFile as (p: string) => void)('moved-a.txt');
    await until(() => box.area().value === 'one\nAI\n', 'a の新しい中身が出ない（古い直しを黙って戻した）');
    assert.equal(box.at('editor-notice').hidden, false, '後から変わったことを言っていない');
    assert.match(box.at('editor-notice').text, /後から変わっています/);
    box.press('その直しを出す');
    assert.equal(box.area().value, 'one\nMINE\n', '出すを押しても直しが戻らない');
  });

  /** a を直して b へ移り、a が外で変わってから a へ戻る（「後から変わっています」が出る形）。 */
  async function staleBack(prefix: string) {
    const a = `${prefix}-a.txt`;
    const b = `${prefix}-b.txt`;
    const disk: Record<string, string> = { [a]: 'one\n', [b]: 'B\n' };
    const box = open(disk);
    const go = (f: string) => (box.ctx.openFile as (p: string) => void)(f);
    go(a);
    await until(() => box.area().value === 'one\n', 'a が開く');
    box.area().value = 'one\nMINE\n';
    box.area().fire('input');
    go(b);
    await until(() => box.area().value === 'B\n', 'b が開く');
    disk[a] = 'one\nAI\n';
    go(a);
    await until(() => box.area().value === 'one\nAI\n' && box.at('editor-notice').hidden === false, '後から変わっていると言う');
    return { box, disk, go, a, b };
  }

  test('**知らせを閉じても、押さずに離れても、直しは失わない（次に戻ったときにまた出す）**', async () => {
    const { box, go, a, b } = await staleBack('closed');
    box.press('×');
    go(b);
    await until(() => box.area().value === 'B\n', 'b が開く');
    go(a);
    await until(() => box.at('editor-notice').hidden === false, '戻っても、もう一度出さない（直しを失った）');
    box.press('その直しを出す');
    assert.equal(box.area().value, 'one\nMINE\n');
  });

  test('**「やめる」を押しても、直しは捨てない（開き直すともう一度出せる）**', async () => {
    const { box, go, a, b } = await staleBack('undo');
    box.press('その直しを出す');
    box.press('やめる');
    assert.equal(box.area().value, 'one\nAI\n');
    go(b);
    await until(() => box.area().value === 'B\n', 'b が開く');
    go(a);
    await until(() => box.at('editor-notice').hidden === false, 'やめたら直しが消えた');
    box.press('その直しを出す');
    assert.equal(box.area().value, 'one\nMINE\n');
  });

  test('「捨てる」を押したら、次に戻ったときは出さない', async () => {
    const { box, go, a, b } = await staleBack('drop');
    box.press('捨てる');
    go(b);
    await until(() => box.area().value === 'B\n', 'b が開く');
    go(a);
    await until(() => box.area().value === 'one\nAI\n', 'a が開く');
    assert.equal(box.at('editor-notice').hidden, true, '捨てたのにまた出した');
  });

  test('**保存の返事の前に移って戻っても、自分の保存を「後から変わっています」と言わない**', async () => {
    const disk: Record<string, string> = { 'own-a.txt': 'one\n', 'own-b.txt': 'B\n' };
    const box = open(disk);
    const go = (f: string) => (box.ctx.openFile as (p: string) => void)(f);
    go('own-a.txt');
    await until(() => box.area().value === 'one\n', 'a が開く');
    const inner = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'PUT') await gate;
      return (inner as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    try {
      box.area().value = 'one\nNEW\n';
      box.area().fire('input');
      box.key('s');
      go('own-b.txt');
      await until(() => box.area().value === 'B\n', 'b が開く');
      release();
      await until(() => disk['own-a.txt'] === 'one\nNEW\n', '保存される');
      await until(() => box.asked.filter((q) => q.method === 'PUT').length === 1, 'PUT が一回');
      // 保存の返事を受け取り切るまで待つ（返事の後の片づけが済んでから戻る）。
      await new Promise((r) => setImmediate(r));
      go('own-a.txt');
      await until(() => box.area().value === 'one\nNEW\n', 'a が開く');
      assert.equal(box.at('editor-notice').hidden, true, `自分の保存を「後から変わっています」と言った: ${box.at('editor-notice').text}`);
    } finally {
      (globalThis as { fetch?: unknown }).fetch = inner;
    }
  });

  test('**移れなかった（繋がらない）あとに直して保存しても、古い預かりを出さない**', async () => {
    const disk: Record<string, string> = { 'fail-a.txt': 'one\n', 'fail-b.txt': 'B\n' };
    const box = open(disk);
    const go = (f: string) => (box.ctx.openFile as (p: string) => void)(f);
    go('fail-a.txt');
    await until(() => box.area().value === 'one\n', 'a が開く');
    box.area().value = 'one\nOLD\n';
    box.area().fire('input');
    const inner = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: { method?: string }) => {
      if (String(url).includes('fail-b.txt')) throw new Error('繋がらない');
      return (inner as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    go('fail-b.txt');
    await until(() => box.state().textContent.includes('開けませんでした'), '開けなかったと言う');
    (globalThis as { fetch?: unknown }).fetch = inner;
    box.area().value = 'one\nNEW\n';
    box.area().fire('input');
    box.key('s');
    await until(() => disk['fail-a.txt'] === 'one\nNEW\n', '保存される');
    await until(() => box.state().textContent.includes('保存しました'), '保存の返事');
    go('fail-b.txt');
    await until(() => box.area().value === 'B\n', 'b が開く');
    go('fail-a.txt');
    await until(() => box.area().value === 'one\nNEW\n', 'a が開く');
    assert.equal(box.at('editor-notice').hidden, true, `古い預かりを出した: ${box.at('editor-notice').text}`);
  });

  test('開けないファイルへ移ったら、前のファイルの知らせを残さない', async () => {
    const { box, go } = await staleBack('gone');
    go('no-such-file.txt');
    await until(() => box.area().disabled === true, '開けない');
    assert.equal(box.at('editor-notice').hidden, true, '前のファイルの知らせが残っている');
  });

  test('離れている間に変わっていなければ、直しをそのまま戻す（対）', async () => {
    const disk: Record<string, string> = { 'kept-a.txt': 'one\n', 'kept-b.txt': 'B\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('kept-a.txt');
    await until(() => box.area().value === 'one\n', 'a が開く');
    box.area().value = 'one\nMINE\n';
    box.area().fire('input');
    (box.ctx.openFile as (p: string) => void)('kept-b.txt');
    await until(() => box.area().value === 'B\n', 'b が開く');
    (box.ctx.openFile as (p: string) => void)('kept-a.txt');
    await until(() => box.area().value === 'one\nMINE\n', '直しが戻らない');
    assert.match(box.state().textContent, /保存していない直しを戻しました/);
  });
});

describe('AI の版を出したあと', () => {
  /**
   * **保存を断られて「AI の版を出す」を押したあと、自分の直しを画面の中にしか残さない。**
   *
   * 欄は AI の版になり直しが無い状態になるので、預かりの片づけが自分の直しの写しを消していた。
   * 自分の直しは画面の中（held）にしか無く、ブラウザを閉じると失っていた。
   */
  test('**ブラウザを閉じて開き直しても、自分の直しを「出す」で戻せる**', async () => {
    const disk: Record<string, string> = { 'held.txt': 'one\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('held.txt');
    await until(() => box.area().value === 'one\n', '開く');
    box.area().value = 'one\nMINE\n';
    box.area().fire('input');
    disk['held.txt'] = 'one\nAI\n';
    box.key('s');
    await until(() => box.at('editor-notice').text.includes('別の所で変わりました'), '保存を断られる');
    box.press('AI の版を出す');
    assert.equal(box.area().value, 'one\nAI\n');
    // 預かりの片づけ（「AI の版を出す」を押したときに仕掛け直された 400 ms の時計）が走り終えるまで待つ。
    // その時計はこれより先に仕掛けたので、先に走る。
    await new Promise((r) => setTimeout(r, 450));
    // ブラウザを閉じて開き直した形（新しいパネル、覚えておく所はそのまま）。
    const again = open(disk, true);
    (again.ctx.openFile as (p: string) => void)('held.txt');
    await until(() => again.area().value === 'one\nAI\n' && again.at('editor-notice').hidden === false, '自分の直しが残っていると言わない');
    assert.match(again.at('editor-notice').text, /取り替える前/);
    again.press('その直しを出す');
    assert.equal(again.area().value, 'one\nMINE\n');
  });

  /** 保存を断られて「AI の版を出す」を押したところまで進める。 */
  async function tookOver(name: string) {
    const disk: Record<string, string> = { [name]: 'one\n', [`other-${name}`]: 'B\n' };
    const box = open(disk);
    const go = (f: string) => (box.ctx.openFile as (p: string) => void)(f);
    go(name);
    await until(() => box.area().value === 'one\n', '開く');
    box.area().value = 'one\nMINE\n';
    box.area().fire('input');
    disk[name] = 'one\nAI\n';
    box.key('s');
    await until(() => box.at('editor-notice').text.includes('別の所で変わりました'), '保存を断られる');
    box.press('AI の版を出す');
    return { box, disk, go };
  }

  test('**AI の版を直して打ち消したら、移って戻っても途中の直しを黙って戻さない**', async () => {
    const { box, go } = await tookOver('undo-typed.txt');
    box.area().value = 'one\nAI\nzz\n';
    box.area().fire('input');
    await until(() => (localStorage.getItem('aas.draft:undo-typed.txt') ?? '').includes('zz'), '途中の直しを預ける');
    box.area().value = 'one\nAI\n';
    box.area().fire('input');
    await until(() => localStorage.getItem('aas.draft:undo-typed.txt') === null, '打ち消したのに途中の直しの預かりが残っている');
    go('other-undo-typed.txt');
    await until(() => box.area().value === 'B\n', '移る');
    go('undo-typed.txt');
    await until(() => box.area().value === 'one\nAI\n', '途中の直しを黙って戻した');
  });

  test('**AI の版を直したあとも、取り替える前の自分の直しは覚えておく所に残る**', async () => {
    const { box } = await tookOver('typed-after.txt');
    box.area().value = 'one\nAI\nq\n';
    box.area().fire('input');
    await until(() => (localStorage.getItem('aas.draft:typed-after.txt') ?? '').includes('q'), '直した分を預ける');
    const parked = localStorage.getItem('aas.held:typed-after.txt');
    assert.equal(parked && (JSON.parse(parked) as { text: string }).text, 'one\nMINE\n', '取り替える前の直しを上書きした');
  });

  test('「自分の直しに戻す」を押したら、取り替える前の直しの預かりは片づける', async () => {
    const { box } = await tookOver('restored.txt');
    assert.ok(localStorage.getItem('aas.held:restored.txt'), '預けていない');
    box.press('自分の直しに戻す');
    assert.equal(box.area().value, 'one\nMINE\n');
    assert.equal(localStorage.getItem('aas.held:restored.txt'), null);
  });

  test('**選んだ範囲を AI が書き換えたあと、手で元に戻したら、移って戻っても AI の直しを黙って戻さない**', async () => {
    const disk: Record<string, string> = { 'patched.txt': 'a\nb\n', 'patched-other.txt': 'B\n' };
    const box = open(disk);
    const go = (f: string) => (box.ctx.openFile as (p: string) => void)(f);
    go('patched.txt');
    await until(() => box.area().value === 'a\nb\n', '開く');
    const done = (box.ctx.applyPatch as (at: unknown) => boolean)({ path: 'patched.txt', from: 1, to: 1, text: 'a', replacement: 'A' });
    assert.equal(done, true);
    assert.equal(box.area().value, 'A\nb\n');
    await until(() => (localStorage.getItem('aas.draft:patched.txt') ?? '').includes('A'), '直しを預ける');
    box.area().value = 'a\nb\n';
    box.area().fire('input');
    await until(() => localStorage.getItem('aas.draft:patched.txt') === null, '元に戻したのに預かりが残っている');
    go('patched-other.txt');
    await until(() => box.area().value === 'B\n', '移る');
    go('patched.txt');
    await until(() => box.area().value === 'a\nb\n', '直しを黙って戻した');
  });
});

/*
 * 開く要求の追い越し・作業場の取り違え・届かない書き換え・続けての保存（読み直しで見つけた）。
 * 時刻では待たない（返事は門で止め、開けたら事象の一巡を数回回すだけ）。
 */
describe('エディタの順番と作業場', () => {
  /** 事象の一巡を数回まわす（Response.json の読み終わりと、その後の続きを流し切る）。時刻は使わない。 */
  const settle = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

  /** 門。url に want を含む頼みだけ、開けるまで止める。 */
  function gateFetch(want: (url: string, init?: { method?: string }) => boolean) {
    const real = globalThis.fetch;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (want(String(url), init as { method?: string })) await gate;
      return real(url, init);
    }) as typeof fetch;
    return { release: () => open(), restore: () => { globalThis.fetch = real; } };
  }

  test('**AI の書き換えの静かな読み直しが、後から押したファイルを上書きしない**', async () => {
    const disk: Record<string, string> = { 'a.txt': 'A1\n', 'b.txt': 'B\n' };
    const t = open(disk);
    const openFile = t.ctx.openFile as (p: string) => void;
    openFile('a.txt');
    await until(() => t.area().value === 'A1\n', 'a が開く');

    const g = gateFetch((u) => u.includes('path=a.txt'));
    disk['a.txt'] = 'A2\n';
    t.emit('session', { type: 'diff', path: 'a.txt', diff: '', added: 1, removed: 1, created: false }); // 静かな読み直し（門で止まる）
    openFile('b.txt');
    await until(() => t.area().value === 'B\n', 'b が開く');
    t.area().value = 'B typed\n';
    t.area().fire('input');

    g.release();
    await settle();
    g.restore();
    assert.equal(t.area().value, 'B typed\n', `後から押した b を、a の読み直しで上書きした: ${JSON.stringify(t.area().value)}`);
    assert.equal(t.at('editor-name').textContent, 'b.txt');
  });

  test('**Ctrl+S を続けて二度押しても、自分の保存を「別の所で変わりました」と断らない**', async () => {
    const disk: Record<string, string> = { 'a.txt': 'one\n' };
    const t = open(disk);
    (t.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => t.area().value === 'one\n', 'a が開く');
    t.area().value = 'two\n';
    t.area().fire('input');

    const g = gateFetch((_u, init) => init?.method === 'PUT');
    t.key('s');
    t.key('s'); // 一度目の返事を待っている間の二度目
    g.release();
    await until(() => /保存/.test(t.state().textContent) && !/保存しています/.test(t.state().textContent), '返事が来る');
    await settle();
    g.restore();
    assert.equal(disk['a.txt'], 'two\n');
    assert.doesNotMatch(t.state().textContent, /保存していません/, `自分の二度目の保存を、衝突として出した: ${t.state().textContent}`);
    assert.equal(t.at('editor-notice').hidden, true, '身に覚えのない衝突の知らせが出ている');
    assert.equal(t.asked.filter((a) => a.method === 'PUT').length, 1, '同じ中身を二度送った');
  });

  test('**作業場を変えたあと、前の作業場で直したものを新しい作業場へ保存しない・預かりも混ぜない**', async () => {
    // 同じリポジトリの二つの写し（同じ名前・同じ中身）。
    const disk: Record<string, string> = { 'README.md': 'same\n' };
    let root = '/w1';
    const t = open(disk);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        const b = JSON.parse(init!.body!) as { root?: string };
        if (b.root !== undefined && b.root !== root) return Response.json({ error: '作業場が変わりました', moved: true }, { status: 409 });
        return inner(url, init as RequestInit);
      }
      const r = await inner(url, init as RequestInit);
      const j = await r.json() as Record<string, unknown>;
      return Response.json(r.ok ? { ...j, root } : j, { status: r.status });
    }) as typeof fetch;

    (t.ctx.openFile as (p: string) => void)('README.md');
    await until(() => t.area().value === 'same\n', '開く');
    t.area().value = 'edited in w1\n';
    t.area().fire('input');
    await until(() => localStorage.getItem('aas.draft:/w1\nREADME.md') !== null, 'w1 の鍵で預ける');

    root = '/w2'; // 📂 で作業場を変えた
    t.key('s');
    await until(() => !/保存しています/.test(t.state().textContent), '返事が来る');
    assert.equal(disk['README.md'], 'same\n', '前の作業場の直しを、新しい作業場のファイルへ書いた');

    // 新しいパネルで、w2 の同じ名前を開いても、w1 の預かりを「戻しました」と出さない。
    t.close();
    const u = open(disk, true);
    const inner2 = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const r = await inner2(url, init);
      if ((init?.method ?? 'GET') === 'PUT') return r;
      const j = await r.json() as Record<string, unknown>;
      return Response.json(r.ok ? { ...j, root } : j, { status: r.status });
    }) as typeof fetch;
    (u.ctx.openFile as (p: string) => void)('README.md');
    await until(() => u.at('editor-name').textContent === 'README.md' && !u.area().disabled, '開く');
    await settle();
    assert.equal(u.area().value, 'same\n', `w1 の直しを w2 のファイルに戻した: ${JSON.stringify(u.area().value)}`);
    assert.notEqual(localStorage.getItem('aas.draft:/w1\nREADME.md'), null, 'w1 の預かりを w2 で片づけた');
  });

  test('**AI の書き換えの道が `./` や `\\` 付きでも、開いているファイルの読み直しが走る。`/plan` の書き換えも**', async () => {
    const disk: Record<string, string> = { 'src/a.txt': 'one\n' };
    const t = open(disk);
    (t.ctx.openFile as (p: string) => void)('src/a.txt');
    await until(() => t.area().value === 'one\n', '開く');

    disk['src/a.txt'] = 'two\n';
    t.emit('session', { type: 'diff', path: './src/a.txt', diff: '', added: 1, removed: 1, created: false });
    await until(() => t.area().value === 'two\n', '`./` 付きの差分で読み直さない');

    disk['src/a.txt'] = 'three\n';
    t.emit('planEvent', { type: 'diff', path: 'src\\a.txt', diff: '', added: 1, removed: 1, created: false });
    await until(() => t.area().value === 'three\n', '段取りの差分で読み直さない');
  });

  test('**「AI の版を出す」を押して読みに行っている間に別のファイルへ移っても、移った先へ前のファイルを入れない**', async () => {
    const disk: Record<string, string> = { 'a.txt': 'A\n', 'b.txt': 'B\n' };
    const t = open(disk);
    const openFile = t.ctx.openFile as (p: string) => void;
    openFile('a.txt');
    await until(() => t.area().value === 'A\n', 'a が開く');
    t.area().value = 'A mine\n';
    t.area().fire('input');
    disk['a.txt'] = 'A ai\n';
    t.emit('session', { type: 'diff', path: 'a.txt', diff: '', added: 1, removed: 1, created: false });

    const g = gateFetch((u) => u.includes('path=a.txt'));
    t.press('AI の版を出す');
    g.restore(); // b はそのまま通す（a の一回目だけ門の中）
    openFile('b.txt');
    await until(() => t.area().value === 'B\n', 'b が開く');
    g.release();
    await settle();
    assert.equal(t.area().value, 'B\n', `b の欄に a の中身を入れた: ${JSON.stringify(t.area().value)}`);
  });
});
