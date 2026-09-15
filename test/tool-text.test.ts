/**
 * 本文に紛れたツール呼び出しの拾い上げ。
 * 生の JSON を人に見せないことと、道具が実際に動くことの両方を見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractToolCalls, ToolTextFilter, toCall, sliceJsonObject } from '../src/agent/tool-text.ts';

/** 切れ端に割って流し込み、画面に出た分と拾った呼び出しを返す。 */
function stream(text: string, size = 7) {
  const filter = new ToolTextFilter();
  let shown = '';
  for (let i = 0; i < text.length; i += size) shown += filter.push(text.slice(i, i + size));
  const rest = filter.end();
  return { shown: shown + rest.text, calls: rest.calls };
}

describe('本文からの拾い上げ', () => {
  test('<tool_call> 形式を拾い、本文からは消える', () => {
    const r = extractToolCalls(
      'まず読みます。<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
    );
    assert.deepEqual(r.calls, [{ name: 'read_file', args: { path: 'a.ts' } }]);
    assert.equal(r.text, 'まず読みます。');
  });

  test('```json の囲みも拾う', () => {
    const r = extractToolCalls('```json\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n```');
    assert.equal(r.calls.length, 1);
    assert.equal(r.text, '');
  });

  test('引数の呼び名が違っても拾う', () => {
    for (const key of ['arguments', 'args', 'parameters', 'input']) {
      const r = extractToolCalls(`{"name":"read_file","${key}":{"path":"a.ts"}}`);
      assert.deepEqual(r.calls[0]?.args, { path: 'a.ts' }, key);
    }
  });

  test('引数を文字列で二重に包んでいても解く', () => {
    const r = extractToolCalls('{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}');
    assert.deepEqual(r.calls[0]?.args, { path: 'a.ts' });
  });

  test('入れ物が無ければ、残りを引数とみなす', () => {
    const r = extractToolCalls('{"name":"read_file","path":"a.ts"}');
    assert.deepEqual(r.calls[0], { name: 'read_file', args: { path: 'a.ts' } });
  });

  test('引数の中の括弧や引用符に釣られない', () => {
    const content = 'if (x) { return "}"; }';
    const r = extractToolCalls(
      `<tool_call>{"name":"write_file","arguments":{"path":"a.ts","content":${JSON.stringify(content)}}}</tool_call>`,
    );
    assert.equal(r.calls[0]?.args.content, content);
    assert.equal(r.text, '');
  });

  test('複数あれば順に拾う', () => {
    const r = extractToolCalls(
      '{"name":"read_file","arguments":{"path":"a.ts"}}\n{"name":"read_file","arguments":{"path":"b.ts"}}',
    );
    assert.deepEqual(r.calls.map((c) => c.args.path), ['a.ts', 'b.ts']);
  });

  test('ただの JSON は呼び出しとみなさない', () => {
    const text = '設定はこうです: {"temperature": 0.2, "maxTokens": 4096}';
    const r = extractToolCalls(text);
    assert.deepEqual(r.calls, []);
    assert.equal(r.text, text, '本文はそのまま残す');
  });

  test('名前らしくないものは拾わない', () => {
    assert.equal(toCall({ name: 'これは 道具ではない', arguments: {} }), undefined);
    assert.equal(toCall({ arguments: { path: 'a' } }), undefined);
    assert.equal(toCall('ただの文字列'), undefined);
  });

  test('文字列の中に生の改行を書いていても読む', () => {
    // 小さいモデルは、書き込む内容を素直に改行して入れてくる。
    const raw = '<tool_call>{"name":"write_file","arguments":'
      + '{"path":"a.ts","content":"const a = 1;\nconst b = 2;\n"}}</tool_call>';
    const r = extractToolCalls(raw);
    assert.equal(r.calls.length, 1, '生の改行で読めなくなっている');
    assert.equal(r.calls[0]?.args.content, 'const a = 1;\nconst b = 2;\n');
    assert.equal(r.text, '');
  });

  test('閉じていない JSON は切り出さない', () => {
    assert.equal(sliceJsonObject('{"a":{"b":1}', 0), undefined);
    assert.equal(sliceJsonObject('{"a":1} のこり', 0), '{"a":1}');
  });
});

describe('流れてくる本文の関所', () => {
  test('切れ端に割れていても、生の JSON は画面に出ない', () => {
    const r = stream('直します。<tool_call>{"name":"write_file","arguments":{"path":"a.ts","content":"x"}}</tool_call>');
    assert.equal(r.shown, '直します。');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]?.name, 'write_file');
  });

  test('切れ目が囲みの途中でも取りこぼさない', () => {
    for (const size of [1, 2, 3, 5, 11, 40]) {
      const r = stream('やります。<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>', size);
      assert.equal(r.shown, 'やります。', `切れ端 ${size}`);
      assert.equal(r.calls.length, 1, `切れ端 ${size}`);
    }
  });

  test('普通の文章は溜め込まずに流す', () => {
    const filter = new ToolTextFilter();
    assert.equal(filter.push('これは'), 'これは');
    assert.equal(filter.push('普通の応答です。'), '普通の応答です。');
    assert.deepEqual(filter.end(), { text: '', calls: [] });
  });

  test('コード片は止めない（呼び出しではないため）', () => {
    const code = '```ts\nconst x = 1;\n```\n';
    const filter = new ToolTextFilter();
    assert.equal(filter.push(code), code, 'ただのコード片で流れが止まっている');
  });

  test('呼び出しでなかった JSON は、溜めた分をそのまま見せる', () => {
    const r = stream('設定: {"temperature": 0.2}');
    assert.equal(r.shown, '設定: {"temperature": 0.2}');
    assert.deepEqual(r.calls, []);
  });

  test('drain は溜めた分をそのまま吐き出す', () => {
    const filter = new ToolTextFilter();
    filter.push('前置き<tool_call>{"name":"read_file"');
    assert.equal(filter.drain(), '<tool_call>{"name":"read_file"');
    assert.equal(filter.push('続き'), '続き', '吐き出したら元に戻る');
  });
});
