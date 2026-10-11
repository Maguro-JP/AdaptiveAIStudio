/**
 * 上限で切った頭が、CP932 の 2 バイトの字の途中で終わる形（85 回目の調査の残り）。
 *
 * UTF-8 の途中の字は落としていたが、CP932 の途中の字は落としていなかった。末尾に先行バイトだけが残ると、
 * 厳密な CP932 の読みも落ち、化けを許した UTF-8 で読んで中身が丸ごと化けていた（`fetch_url` と `@` の指名）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { readBounded } from '../src/agent/tools/network.ts';
import { readMentions } from '../src/agent/mention.ts';

// 「あ」の CP932 は 0x82 0xA0。Node に CP932 の書き出しは無いので、バイトで組む。
const sjisA = (n: number): Buffer => Buffer.from(Array.from({ length: n }, () => [0x82, 0xa0]).flat());
let shiftJisSupported = true;
try { new TextDecoder('shift_jis'); } catch { shiftJisSupported = false; }

describe('CP932 の字の途中で切れた頭', { skip: !shiftJisSupported && 'この Node は shift_jis を読めない' }, () => {
  test('fetch_url の上限で切っても、化けずに CP932 として読む', async () => {
    const page = sjisA(1000);
    const body = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < page.length; i += 1001) c.enqueue(page.subarray(i, i + 1001)); c.close(); },
    });
    const text = await readBounded(new Response(body), 1001, 'text/plain');
    assert.match(text, /^あ+$/, `化けた: ${text.slice(0, 20)}`);
  });

  test('@ の指名で頭だけ読んでも、化けずに CP932 として読む', async () => {
    const dir = await tempDir('aas-cp932-cut-');
    // 頭に 1 バイト置き、読む上限（400,000 バイト）がちょうど字の途中に当たるようにする
    await writeFile(join(dir, 'big.txt'), Buffer.concat([Buffer.from('a'), sjisA(200_001)]));
    const [read] = await readMentions('@big.txt を見て', dir, { maxBytes: 600 });
    assert.ok(read?.ok, `読めていない: ${read?.body}`);
    assert.doesNotMatch(read!.body, /�/, `化けた: ${read!.body.slice(0, 40)}`);
    assert.match(read!.body, /Shift_JIS として読みました/, read!.body.slice(0, 80));
    assert.match(read!.body, /aあ/, read!.body.slice(0, 200));
  });
});
