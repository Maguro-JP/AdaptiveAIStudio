import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractToolCalls, ToolTextFilter } from '../src/agent/tool-text.ts';

const known = (n: string) => n === 'read_file';

test('考えの中に書いた呼び出しの形は、呼び出しとして拾わない', () => {
  const r = extractToolCalls('<think>例えば <tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call> と書けるが、やめる</think>答えは 2', known);
  assert.deepEqual(r.calls, []);
  assert.equal(r.text, '答えは 2');
});

test('閉じない考えの後ろは全部外し、何も呼ばない', () => {
  const r = extractToolCalls('<think>考え中 {"name":"read_file","arguments":{"path":"x"}}', known);
  assert.deepEqual(r.calls, []);
});

test('考えの後の本物の呼び出しは拾う', () => {
  const r = extractToolCalls('<think>a</think><tool_call>{"name":"read_file","arguments":{"path":"y"}}</tool_call>', known);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0]!.args, { path: 'y' });
});

test('配列で並べた呼び出しの跡（[,]）を本文に残さない。答えの中の [] は消さない', () => {
  const r = extractToolCalls('[{"name":"read_file","arguments":{"path":"a"}},{"name":"read_file","arguments":{"path":"b"}}]', known);
  assert.equal(r.calls.length, 2);
  assert.equal(r.text, '');
  const keep = extractToolCalls('arr = [] にしてから {"name":"read_file","arguments":{"path":"a"}}', known);
  assert.match(keep.text, /arr = \[\]/);
});

test('流して返すときも、考えの中の呼び出しを拾わない', () => {
  const f = new ToolTextFilter();
  f.push('<think>例 {"name":"read_file","arguments":{"path":"x"}}</think>ok');
  assert.deepEqual(f.end(known).calls, []);
});
