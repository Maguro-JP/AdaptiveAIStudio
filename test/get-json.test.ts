/**
 * 画面が本体から読むときは、断られた（400・404・500・502）のを中身として使わない。
 *
 * `fetch(p).then((r) => r.json())` は断られたときも `{ error }` を返す。状態（`/api/state`）が 500 を返しただけで `{ error }` を
 * 全部のパネルへ配り、パネルが順に止まっていた。新しい世代の確かめは、配布元に訊けなかった（502）のを「新しい世代は
 * ありません」と言っていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getJson } from '../src/ui/web/get-json.js';

const web = join(import.meta.dirname, '..', 'src', 'ui', 'web');

function answer(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

test('**断られたら投げ、本体の文を理由にする**。読めたら中身を返す', async () => {
  const prev = globalThis.fetch;
  try {
    globalThis.fetch = answer(200, '{"list":[1]}');
    assert.deepEqual(await getJson('/api/x'), { list: [1] });
    globalThis.fetch = answer(500, '{"error":"状態を読めませんでした"}');
    await assert.rejects(() => getJson('/api/state'), /状態を読めませんでした/);
    globalThis.fetch = answer(502, 'Bad Gateway');
    await assert.rejects(() => getJson('/api/models/newer'), /502/);
    globalThis.fetch = answer(200, 'not json');
    await assert.rejects(() => getJson('/api/x'), /読めませんでした/);
  } finally {
    globalThis.fetch = prev;
  }
});

/**
 * `fetch(` から文の終わり（`;`）までの間に `.json()` を読み、その間に `ok` を見ていない形を拾う。行ごとに見ていたときは、
 * 引数に `)` を含む `(await fetch(`…${encodeURIComponent(id)}`)).json()` を拾えなかった。
 */
function unchecked(src: string): number[] {
  const at: number[] = [];
  for (const m of src.matchAll(/\bfetch\(/g)) {
    const i = m.index ?? 0;
    const end = src.indexOf(';', i);
    const stmt = src.slice(i, end < 0 ? i + 400 : end);
    if (/\.json\(\)/.test(stmt) && !/\.ok\b/.test(stmt)) at.push(src.slice(0, i).split('\n').length);
  }
  return at;
}

test('**画面の JS は、ok を見ずに json を読まない**（読むときは getJson を通す）', async () => {
  const bad: string[] = [];
  for (const name of (await readdir(web)).filter((n) => n.endsWith('.js') && n !== 'get-json.js')) {
    const src = (await readFile(join(web, name), 'utf8')).split('\n').map((l) => (/^\s*(\/\/|\*)/.test(l) ? '' : l)).join('\n');
    for (const line of unchecked(src)) bad.push(`${name}:${line}`);
  }
  assert.deepEqual(bad, [], `ok を見ずに json を読んでいる:\n${bad.join('\n')}`);
});

test('見張りは、引数に括弧を含む形・括弧の無い then も拾う', () => {
  assert.equal(unchecked("const b = (await fetch(`/api/m?id=${encodeURIComponent(id)}`)).json();").length, 1);
  assert.equal(unchecked("const b = await fetch('/api/x').then(r => r.json());").length, 1);
  assert.equal(unchecked("const r = await fetch('/api/x').then(async (r) => ({ ok: r.ok, body: await r.json() }));").length, 0);
  assert.equal(unchecked("const r = await fetch('/api/x', { method: 'POST' });").length, 0);
});
