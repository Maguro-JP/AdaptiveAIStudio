/**
 * 道具の呼び方を、文章で教える。
 *
 * 型（chat wrapper）が当てずっぽうのときの唯一の道なので、
 * **形が崩れていないこと**を見る。崩れると、モデルは自分の流儀で書き、
 * こちらは拾えない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toolPrompt, paramLine } from '../src/runtime/tool-prompt.ts';
import { extractToolCalls } from '../src/agent/tool-text.ts';

describe('引数の形', () => {
  test('要るものと、要らないものを分ける', () => {
    assert.equal(
      paramLine({ type: 'object', properties: { path: { type: 'string' }, all: { type: 'boolean' } }, required: ['path'] }),
      '{ "path": string, "all": boolean? }',
    );
  });
  test('形が無ければ、空の印', () => {
    assert.equal(paramLine(undefined), '{}');
  });
});

describe('本文に載せる説明', () => {
  const text = toolPrompt([
    { name: 'read_file', description: 'ファイルを読む', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'list_files' },
  ]);

  test('道具の名前と引数が載る', () => {
    assert.match(text, /read_file — ファイルを読む/);
    assert.match(text, /"path": string/);
    assert.match(text, /list_files/);
  });

  test('返し方の例が載っている（形だけ言っても真似されない）', () => {
    assert.match(text, /<tool_call>\{"name"/);
  });

  test('例は、こちらの拾い方でそのまま拾える', () => {
    // 教えた形を自分で拾えないなら、教えている形が間違っている。
    const said = '<tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}</tool_call>';
    const got = extractToolCalls(said);
    assert.equal(got.calls[0]?.name, 'read_file');
    assert.deepEqual(got.calls[0]?.args, { path: 'a.ts' });
  });

  test('道具が無ければ、何も足さない', () => {
    assert.equal(toolPrompt([]), '');
  });
});
