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
function open(disk: Record<string, string>, keep = false) {
  if (!keep) localStorage.clear();
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
  const ctx: Record<string, unknown> = {
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
    localStorage.clear();
    const disk = { 'a.ts': 'はじめ\n' };
    const first = open(disk, true);
    (first.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => first.area().value === 'はじめ\n', 'ファイルが開く');
    await typeInto(first, '書きかけ\n');

    // ブラウザを閉じて開き直した、と同じこと（パネルを作り直す）。
    const again = open(disk, true);
    (again.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => again.area().value === '書きかけ\n', '打ったものが戻る');
    assert.match(again.state().textContent, /保存していない直しを戻しました/, again.state().textContent);
  });

  test('**ファイルが変わっていたら、黙って戻さない**', async () => {
    localStorage.clear();
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
    localStorage.clear();
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
    localStorage.clear();
    const disk = { 'a.ts': 'はじめ\n' };
    const box = open(disk, true);
    (box.ctx.openFile as (p: string) => void)('a.ts');
    await until(() => box.area().value === 'はじめ\n', 'ファイルが開く');
    await typeInto(box, 'あ'.repeat(600 * 1024));
    const bar = box.find((n) => n.className.startsWith('editor-notice'));
    assert.match(bar.text, /ブラウザを閉じると残りません/, bar.text);
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

  test('混ざっているものは、触らない（直していない行まで変えない）', async () => {
    const disk = { 'a.txt': 'one\r\ntwo\nthree\r\n' };
    const box = open(disk);
    (box.ctx.openFile as (p: string) => void)('a.txt');
    await until(() => box.area().value.includes('one'), 'ファイルが開く');
    box.area().value = 'one\ntwo\nTHREE\n';
    box.area().oninput!();
    box.key('s');
    await until(() => disk['a.txt'] !== 'one\r\ntwo\nthree\r\n', '保存できる');
    assert.equal(disk['a.txt'], 'one\ntwo\nTHREE\n', `混ざっているのに CRLF へ寄せている: ${JSON.stringify(disk['a.txt'])}`);
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
      return inner(url as unknown as RequestInfo, init as RequestInit);
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
});
