/**
 * 流れの板に出る文の中の URL が、押せる形になっていること。
 *
 * 「手で取るなら: ブラウザで開く: https://…」を出しても、写して貼らせる
 * のでは案内になっていない。**文字は文字のまま**入れ、URL だけを a にする。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, type StubNode } from './dom-stub.ts';

installDom();
const { linkify } = await import('../src/ui/web/panels.js') as unknown as {
  linkify: (text: string) => StubNode;
};

describe('URL を押せる形にする', () => {
  test('URL だけが a になり、前後の文字は文字のまま', () => {
    const frag = linkify('ブラウザで開く: https://huggingface.co/Qwen/tree/main に置く');
    const kids = frag.children;
    assert.equal(kids.length, 3);
    assert.equal(kids[0]!.textContent, 'ブラウザで開く: ');
    const a = kids[1]! as StubNode & { href?: string; target?: string; rel?: string; tagName?: string };
    assert.equal(a.tagName?.toLowerCase(), 'a');
    assert.equal(a.href, 'https://huggingface.co/Qwen/tree/main');
    assert.equal(a.textContent, 'https://huggingface.co/Qwen/tree/main');
    assert.equal(a.target, '_blank');
    assert.match(a.rel ?? '', /noopener/);
    assert.equal(kids[2]!.textContent, ' に置く');
  });

  test('URL が無ければ、文字だけ（対）', () => {
    const frag = linkify('ふつうの文');
    assert.equal(frag.children.length, 1);
    assert.equal(frag.children[0]!.textContent, 'ふつうの文');
    assert.notEqual((frag.children[0] as { tagName?: string }).tagName?.toLowerCase(), 'a');
  });

  test('HTML として流し込まない', () => {
    // 外から来た文が画面を書き換える口にならないこと。
    const frag = linkify('<img src=x onerror=alert(1)> https://a.example/');
    assert.equal(frag.children[0]!.textContent, '<img src=x onerror=alert(1)> ');
  });
});
