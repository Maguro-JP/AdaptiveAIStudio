/**
 * 同じ並びを吐き続けたら、こちらで切る。
 *
 * 実機で「1+1=」に `1+100000000…` と 0 を書き続け、画面の帯は 4 分 36 秒
 * 「書いています」のままだった。**止める手が無かったので、上限まで吐き切る
 * まで終わらない。**模型の機嫌ではなく、止め方が無いという作りの問題。
 *
 * `test/runaway.test.ts` は見つける所だけを見る。ここは**中で読む口に
 * 繋がっているか**を見る。繋いでいなければ、見つけられても止まらない。
 *
 * 本物のライブラリと GGUF は用意できないので、受け口の呼ばれ方だけを真似る
 * （モック）。本物と同じく、**止められるまで吐き続ける**ものにする。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { InProcRuntime } from '../src/runtime/inproc.ts';

/** 何文字まで吐こうとしたか。止まっていなければ、ここまで届く。 */
const WOULD_EMIT = 4000;

interface Ran { emitted: number; stopped: boolean }

/**
 * 止められるまで同じものを吐き続けるモック。
 *
 * 本物（node-llama-cpp）は `signal` が立つと生成をやめる。ここも同じにする。
 * `head` を先に吐いてから繰り返しに入るので、**頭を巻き込んで消していないか**も見られる。
 */
function runawayLib(ran: Ran, head: string, unit: string) {
  return async () => ({
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
      }),
    }),
    LlamaChatSession: class {
      chatWrapper = { wrapperName: 'QwenChatWrapper' };
      setChatHistory(): void { /* 見ない */ }
      async prompt(_text: string, o: {
        onTextChunk?: (t: string) => void;
        signal?: AbortSignal;
        stopOnAbortSignal?: boolean;
      } = {}): Promise<string> {
        // **ツールを渡さない回でも、止める合図が繋がっていること。**
        // ここは以前ツールを使うときだけ繋いでいたので、雑談では止まらなかった。
        assert.ok(o.signal, '止める合図が渡っていない');
        assert.equal(o.stopOnAbortSignal, true, '止めても投げない設定になっている');
        let out = head;
        o.onTextChunk?.(head);
        for (let i = 0; i < WOULD_EMIT && !o.signal.aborted; i += 1) {
          out += unit;
          o.onTextChunk?.(unit);
        }
        ran.emitted = out.length;
        ran.stopped = o.signal.aborted;
        return out;
      }
    },
  });
}

/** SSE から、本文だけを拾う。 */
function bodyOf(raw: string): string {
  let text = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]' || !data.startsWith('{')) continue;
    const p = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
    text += p.choices?.[0]?.delta?.content ?? '';
  }
  return text;
}

async function ask(head: string, unit: string, stream = true): Promise<{
  ran: Ran; text: string; logs: string[];
}> {
  const dir = await tempDir('aas-runaway-');
  await writeFile(join(dir, 'm.gguf'), 'GGUF');
  const ran: Ran = { emitted: 0, stopped: false };
  const logs: string[] = [];
  const rt = new InProcRuntime({
    modelsDir: dir, port: 0,
    load: runawayLib(ran, head, unit),
    onLog: (line: string) => logs.push(line),
  } as ConstructorParameters<typeof InProcRuntime>[0]);
  const { baseUrl } = await rt.ensureLoaded('m.gguf');
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'm.gguf', stream,
        messages: [{ role: 'user', content: '1+1=' }],
      }),
    });
    const raw = await r.text();
    if (stream) return { ran, text: bodyOf(raw), logs };
    const got = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
    return { ran, text: got.choices?.[0]?.message?.content ?? '', logs };
  } finally { await rt.shutdown(); }
}

describe('同じ並びを吐き続けたら、切る', () => {
  test('**0 を書き続ける回が、止まる**', async () => {
    const { ran, text } = await ask('1+1', '0');
    assert.equal(ran.stopped, true, '止める合図が立っていない');
    assert.ok(ran.emitted < WOULD_EMIT, `最後まで吐いている: ${ran.emitted} 文字`);
    // 画面へ出したものも、繰り返しの手前で切れていること。
    assert.ok(!/0{300}/.test(text), `切らずに流している: ${text.length} 文字`);
  });

  test('**頭は残す。**切るのは繰り返しの分だけ', async () => {
    const { text } = await ask('答えは 2 です。', 'あ');
    assert.ok(text.startsWith('答えは 2 です。'), `頭まで消している: ${JSON.stringify(text.slice(0, 40))}`);
  });

  test('**なぜ切ったかを、記録に出す**（黙って切ると途中で終わったように見える）', async () => {
    const { logs } = await ask('1+1', '0');
    assert.ok(logs.some((l) => /繰り返していたので止めました/.test(l)),
      `理由を言っていない: ${JSON.stringify(logs)}`);
  });

  test('**繰り返さない回は、最後まで流す（対）**', async () => {
    // ここが落ちると、普通の答えまで途中で切っていることになる。
    const { ran, text } = await ask('', '');
    assert.equal(ran.stopped, false, '切る必要の無い回で止めている');
    assert.equal(text, '');
  });

  /**
   * 切る所を、流して返す道にしか入れていなかった。
   *
   * まとめて返す道（`stream: false`）では止まらず、maxTokens まで吐き切るまで
   * 終わらない。判じるための呼び出し（指摘かどうか・要約）はこちらを通るので、
   * 画面が固まらなくても、裏で同じだけ待たされる。
   */
  test('**まとめて返す道でも、止まる**', async () => {
    const { ran, text } = await ask('1+1', '0', false);
    assert.equal(ran.stopped, true, '止める合図が立っていない');
    assert.ok(ran.emitted < WOULD_EMIT, `最後まで吐いている: ${ran.emitted} 文字`);
    assert.ok(!/0{300}/.test(text), `切らずに返している: ${text.length} 文字`);
    assert.ok(text.startsWith('1+1'), `頭まで消している: ${JSON.stringify(text.slice(0, 20))}`);
  });

  test('まとめて返す道でも、繰り返さない回はそのまま（対）', async () => {
    const { ran, text } = await ask('答えは 2 です。', '', false);
    assert.equal(ran.stopped, false, '切る必要の無い回で止めている');
    assert.equal(text, '答えは 2 です。');
  });
});
