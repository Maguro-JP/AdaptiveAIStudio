/**
 * GGUF だけで道具を呼べるか。
 *
 * ここまで、中で読む口は `tools` を**丸ごと無視していた**。
 * だから GGUF を置いても会話しか出来ず、「コーディングが出来る」は
 * 外のモデルを繋いだときだけの話だった。GGUF 単体で成り立たせる。
 *
 * 本物のライブラリと GGUF は用意できないので、受け口の呼ばれ方だけを
 * 真似る。**差し替えたことが分かる形で書く。**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { InProcRuntime, toHistory, type ChatMessage } from '../src/runtime/inproc.ts';

interface LibFn { description?: string; params?: unknown; handler: (a: unknown) => unknown }
interface Seen { history: unknown[]; asked: string; functions?: Record<string, LibFn> }

/** ライブラリが選んだ「道具の呼び方」の型。差し替えでも本物と同じ場所に置く。 */
let wrapperName = 'QwenChatWrapper';

/**
 * 本物の代わり。渡された道具のうち `wants` を、渡された引数で一度呼ぶ。
 * 本物と同じく、**受け口が止めたら、そこまでを返す**（投げない）。
 */
function fakeLib(
  seen: Seen,
  wants?: { name: string; args: unknown },
  said = '',
  /** 止められたときに投げる作り。本物がこちらだった場合に備える。 */
  throws = false,
) {
  return async () => ({
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
      }),
    }),
    LlamaChatSession: class {
      chatWrapper = { wrapperName };
      setChatHistory(h: unknown[]) { seen.history = h; }
      async prompt(text: string, o: {
        onTextChunk?: (t: string) => void;
        functions?: Record<string, LibFn>;
        stopOnAbortSignal?: boolean;
        signal?: AbortSignal;
      } = {}) {
        seen.asked = text;
        seen.functions = o.functions;
        for (const part of [...said]) o.onTextChunk?.(part);
        if (wants) {
          const fn = o.functions?.[wants.name];
          assert.ok(fn, `渡していない道具を呼ぼうとした: ${wants.name}`);
          fn.handler(wants.args);
          // 受け口の中で止められたはず。本物はそこで生成をやめる。
          assert.equal(o.signal?.aborted, true, '受け口で止めたのに、止まっていない');
          assert.equal(o.stopOnAbortSignal, true, '止めると投げる設定のままになっている');
          if (throws) throw new Error('AbortError');
        }
        return said;
      }
    },
  });
}

/** SSE を、上の層（provider）と同じ読み方で解く。 */
async function readStream(res: Response): Promise<{
  text: string;
  calls: { index: number; id?: string; name?: string; args?: string }[];
  finish: string | null;
}> {
  const raw = await res.text();
  let text = '';
  let finish: string | null = null;
  const calls: { index: number; id?: string; name?: string; args?: string }[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;
    const p = JSON.parse(data) as {
      choices: { delta: {
        content?: string;
        tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
      }; finish_reason: string | null }[];
    };
    const choice = p.choices[0]!;
    text += choice.delta.content ?? '';
    for (const tc of choice.delta.tool_calls ?? []) {
      calls.push({ index: tc.index, id: tc.id, name: tc.function?.name, args: tc.function?.arguments });
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  return { text, calls, finish };
}

async function serve(
  seen: Seen, wants?: { name: string; args: unknown }, said = '', throws = false,
) {
  const dir = await tempDir('aas-tools-');
  await writeFile(join(dir, 'm.gguf'), 'GGUF');
  const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: fakeLib(seen, wants, said, throws) });
  const { baseUrl } = await rt.ensureLoaded('m.gguf');
  return { rt, baseUrl };
}

/** 上の層が送ってくるのと同じ形。 */
const TOOLS = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'ファイルを読む',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
}];

describe('GGUF だけで道具を呼ぶ', () => {
  test('道具を渡すと、呼び出しが OpenAI の形で返る', async () => {
    const seen: Seen = { history: [], asked: '' };
    const { rt, baseUrl } = await serve(seen, { name: 'read_file', args: { path: 'src/a.ts' } });
    try {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm.gguf', stream: true, tools: TOOLS,
          messages: [{ role: 'user', content: 'src/a.ts を読んで' }],
        }),
      });
      const got = await readStream(r);
      assert.equal(got.finish, 'tool_calls', `道具を呼んだのに ${got.finish} で終えている`);
      assert.equal(got.calls.length, 1);
      assert.equal(got.calls[0]!.name, 'read_file');
      assert.equal(got.calls[0]!.args, JSON.stringify({ path: 'src/a.ts' }));
      assert.ok(got.calls[0]!.id, 'id が無いと、結果を結び直せない');
      // 説明と引数の形を、そのまま渡していること。渡さないと選べない。
      assert.equal(seen.functions?.read_file?.description, 'ファイルを読む');
      assert.deepEqual(seen.functions?.read_file?.params, TOOLS[0]!.function.parameters);
    } finally { await rt.shutdown(); }
  });

  test('道具を渡さなければ、これまでどおり文字だけ', async () => {
    // 対で見る。常に道具の形で返す作りでも、上の試験だけなら通ってしまう。
    const seen: Seen = { history: [], asked: '' };
    const { rt, baseUrl } = await serve(seen, undefined, 'はい');
    try {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm.gguf', stream: true, messages: [{ role: 'user', content: 'やあ' }] }),
      });
      const got = await readStream(r);
      assert.equal(got.text, 'はい');
      assert.equal(got.finish, 'stop');
      assert.deepEqual(got.calls, []);
      assert.equal(seen.functions, undefined, '道具を渡していないのに、渡している');
    } finally { await rt.shutdown(); }
  });

  test('止めたときに投げてくる作りでも、呼び出しを落とさない', async () => {
    // こちらは受け口の中で生成を止める。ライブラリがそれを「止められた」
    // として投げてくると、**何を呼ぼうとしたのかが例外に化けて消える**。
    // 画面には「止まりました」だけが出て、道具は一つも動かない。
    const seen: Seen = { history: [], asked: '' };
    const { rt, baseUrl } = await serve(seen, { name: 'read_file', args: { path: 'x' } }, '', true);
    try {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm.gguf', stream: true, tools: TOOLS,
          messages: [{ role: 'user', content: 'x を読んで' }],
        }),
      });
      const got = await readStream(r);
      assert.equal(got.finish, 'tool_calls', `投げられた拍子に ${got.finish} になっている`);
      assert.equal(got.calls[0]?.name, 'read_file');
      assert.ok(!got.text.includes('止まりました'), `例外に化けている: ${got.text}`);
    } finally { await rt.shutdown(); }
  });

  test('道具を呼んでいないのに落ちたら、そう言う（対）', async () => {
    // 何でも道具の形で返す作りにすると、本当の故障が黙って消える。
    const seen: Seen = { history: [], asked: '' };
    const dir = await tempDir('aas-tools-err-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const rt = new InProcRuntime({
      modelsDir: dir, port: 0,
      load: async () => ({
        getLlama: async () => ({
          loadModel: async () => ({
            createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
          }),
        }),
        LlamaChatSession: class {
          setChatHistory(h: unknown[]) { seen.history = h; }
          async prompt(): Promise<string> { throw new Error('記憶が足りません'); }
        },
      }),
    });
    try {
      const { baseUrl } = await rt.ensureLoaded('m.gguf');
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm.gguf', stream: true, tools: TOOLS,
          messages: [{ role: 'user', content: 'やあ' }],
        }),
      });
      const got = await readStream(r);
      assert.match(got.text, /記憶が足りません/, '落ちたことを握り潰している');
      // **stop で終えない。**stop は「言い終えた」の意味で、上の層は
      // 成功として扱う。落ちたものを完了と記録しない。
      assert.equal(got.finish, 'error');
    } finally { await rt.shutdown(); }
  });

  test('道具の結果で終わっているときは、前の依頼を訊き直さない', async () => {
    // 訊き直すと、道具を呼んだ跡ごと履歴から落ちる。落ちるとモデルは
    // 同じ道具をもう一度呼び、同じところを延々と回る。
    const seen: Seen = { history: [], asked: '' };
    const { rt, baseUrl } = await serve(seen, undefined, 'できました');
    try {
      await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm.gguf', stream: true, tools: TOOLS,
          messages: [
            { role: 'user', content: 'src/a.ts を読んで' },
            { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: '中身です' },
          ],
        }),
      });
      assert.notEqual(seen.asked, 'src/a.ts を読んで', '同じ依頼を訊き直している');
      // 呼び出しと結果が、一つの塊として履歴に残っていること。
      assert.deepEqual(seen.history, [
        { type: 'user', text: 'src/a.ts を読んで' },
        { type: 'model', response: [{ type: 'functionCall', name: 'read_file', params: { path: 'src/a.ts' }, result: '中身です' }] },
      ]);
    } finally { await rt.shutdown(); }
  });

  test('やめたときは、道具も終わりも送らない', async () => {
    const seen: Seen = { history: [], asked: '' };
    const { rt, baseUrl } = await serve(seen, undefined, 'あ');
    try {
      const ctrl = new AbortController();
      const p = fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm.gguf', stream: true, tools: TOOLS, messages: [{ role: 'user', content: 'やあ' }] }),
      });
      ctrl.abort();
      await assert.rejects(p);
    } finally { await rt.shutdown(); }
  });
});

describe('履歴の組み直し', () => {
  test('道具の返事は、呼び出しの側に畳む', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '決まり' },
      { role: 'user', content: 'やって' },
      { role: 'assistant', content: '読みます', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } },
        { id: 'b', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'b', content: 'x, y' },
      { role: 'tool', tool_call_id: 'a', content: 'なかみ' },
    ];
    assert.deepEqual(toHistory(messages), [
      { type: 'system', text: '決まり' },
      { type: 'user', text: 'やって' },
      { type: 'model', response: [
        '読みます',
        { type: 'functionCall', name: 'read_file', params: { path: 'x' }, result: 'なかみ' },
        { type: 'functionCall', name: 'list_dir', params: {}, result: 'x, y' },
      ] },
    ]);
  });

  test('壊れた引数でも落とさない', () => {
    // 小さいモデルは平気で壊れた JSON を出す。ここで落ちると会話ごと終わる。
    const got = toHistory([
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'f', arguments: '{壊れ' } }] },
    ]);
    const call = (got[0] as { response: { params: { __parseError?: boolean } }[] }).response[0]!;
    assert.equal(call.params.__parseError, true);
  });

  test('何も言っていない行は置かない', () => {
    assert.deepEqual(toHistory([{ role: 'assistant', content: '' }]), []);
  });
});

describe('道具の呼び方が合っているか、言う', () => {
  test('当てずっぽうの型に落ちたら、そう言う', async () => {
    // ライブラリはモデルの中身から型を選ぶ。選び損ねると General /
    // Llama2Chat に落ちる。**文法としては成立してしまう**ので、何も起きない。
    // モデルはその呼び方を習っていないので、道具を一度も呼ばない。
    // 画面からは「雑談しかしない」に見える。黙らせない。
    const seen: Seen = { history: [], asked: '' };
    const said: string[] = [];
    const dir = await tempDir('aas-wrap-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    wrapperName = 'Llama2Chat';
    const rt = new InProcRuntime({
      modelsDir: dir, port: 0, load: fakeLib(seen), onLog: (l) => said.push(l),
    });
    try {
      await rt.ensureLoaded('m.gguf');
      assert.deepEqual(rt.wrappers(), [{ ref: 'm.gguf', wrapper: 'Llama2Chat', guessed: true }]);
      assert.ok(said.some((l) => l.includes('当てずっぽう')), `言っていない: ${said.join(' / ')}`);
    } finally { await rt.shutdown(); wrapperName = 'QwenChatWrapper'; }
  });

  test('合う型が見つかったら、騒がない（対）', async () => {
    // 何にでも警告を出すと、出ているのが普通になって誰も読まなくなる。
    const seen: Seen = { history: [], asked: '' };
    const said: string[] = [];
    const dir = await tempDir('aas-wrap2-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const rt = new InProcRuntime({
      modelsDir: dir, port: 0, load: fakeLib(seen), onLog: (l) => said.push(l),
    });
    try {
      await rt.ensureLoaded('m.gguf');
      assert.equal(rt.wrappers()[0]?.guessed, false);
      assert.ok(!said.some((l) => l.includes('当てずっぽう')), `要らない警告を出している: ${said.join(' / ')}`);
      // どの型で読んだかは、いつでも出す（確かめる先が無いと、疑う先が増える）。
      assert.ok(said.some((l) => l.includes('QwenChatWrapper')), `型を言っていない: ${said.join(' / ')}`);
    } finally { await rt.shutdown(); }
  });
});

describe('窓を出力で使い切らせない', () => {
  test('上限は、窓に対して決め直す', async () => {
    // 上の層は既定で 4096 を送ってくる。窓も 4096 のとき、出力だけで窓を
    // 使い切る。**実際にそうなった。**止まらずに書き続け、溢れてライブラリが
    // 落ちる。CPU で動かすと、その間ずっと 100% を使う。
    // 「打っても返事が来ない、機械が固まる」の正体がこれ。
    const seen: Seen = { history: [], asked: '' };
    const dir = await tempDir('aas-cap-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    let got: number | undefined;
    const rt = new InProcRuntime({
      modelsDir: dir, port: 0, contextSize: 4096,
      load: async () => ({
        getLlama: async () => ({
          loadModel: async () => ({
            createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
          }),
        }),
        LlamaChatSession: class {
          chatWrapper = { wrapperName: 'QwenChatWrapper' };
          setChatHistory(h: unknown[]) { seen.history = h; }
          async prompt(_t: string, o: { maxTokens?: number } = {}) { got = o.maxTokens; return 'はい'; }
        },
      }),
    });
    try {
      const { baseUrl } = await rt.ensureLoaded('m.gguf');
      await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm.gguf', stream: true, max_tokens: 4096,
          messages: [{ role: 'user', content: 'やあ' }],
        }),
      });
      assert.ok(got !== undefined, '上限を渡していない');
      assert.ok(got < 4096, `窓ぶん全部を出力に使わせている: ${got}`);
      assert.ok(got >= 256, `狭すぎて何も言えない: ${got}`);
    } finally { await rt.shutdown(); }
  });

  test('落ちたときは stop で終えない', async () => {
    // stop は「言い終えた」の意味。上の層は成功として扱い、画面には
    // 「完了・検証済み」と出る。**落ちたものを完了と記録しない。**
    const seen: Seen = { history: [], asked: '' };
    const dir = await tempDir('aas-err-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const rt = new InProcRuntime({
      modelsDir: dir, port: 0,
      load: async () => ({
        getLlama: async () => ({
          loadModel: async () => ({
            createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
          }),
        }),
        LlamaChatSession: class {
          chatWrapper = { wrapperName: 'QwenChatWrapper' };
          setChatHistory(h: unknown[]) { seen.history = h; }
          async prompt(): Promise<string> { throw new Error('窓に入りません'); }
        },
      }),
    });
    try {
      const { baseUrl } = await rt.ensureLoaded('m.gguf');
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm.gguf', stream: true, messages: [{ role: 'user', content: 'やあ' }] }),
      });
      const raw = await r.text();
      assert.match(raw, /"finish_reason":"error"/, `落ちたのに stop で終えている: ${raw.slice(-200)}`);
      assert.match(raw, /窓に入りません/, '理由を伝えていない');
    } finally { await rt.shutdown(); }
  });
});

/**
 * 型が当てずっぽうのとき、道具は**本文で**渡して、本文から拾う。
 *
 * ライブラリ経由で渡しても、その型ではモデルに何も届かない。届かないので
 * 一度も呼ばず、「動いているが何もしない」だけが残る。いちばん質が悪い。
 */
describe('型が合わないモデルでも、道具を呼ばせる', () => {
  test('道具はライブラリに渡さず、本文へ書いて渡す', async () => {
    const seen: Seen = { history: [], asked: '' };
    wrapperName = 'General';
    const { rt, baseUrl } = await serve(seen, undefined, 'はい');
    try {
      await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm.gguf', stream: false, tools: TOOLS,
          messages: [{ role: 'user', content: 'a.ts を読んで' }],
        }),
      });
      assert.equal(seen.functions, undefined, '届かない道を通そうとしている');
      const text = JSON.stringify(seen.history);
      assert.match(text, /read_file/, '道具の名前が本文に無い');
      assert.match(text, /tool_call/, '返し方を教えていない');
    } finally { await rt.shutdown(); wrapperName = 'QwenChatWrapper'; }
  });

  test('本文に書かれた呼び出しを、OpenAI の形にして返す', async () => {
    const seen: Seen = { history: [], asked: '' };
    wrapperName = 'General';
    const said = '見てみます。<tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}</tool_call>';
    const { rt, baseUrl } = await serve(seen, undefined, said);
    try {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm.gguf', stream: false, tools: TOOLS,
          messages: [{ role: 'user', content: 'a.ts を読んで' }],
        }),
      });
      const body = await r.json() as {
        choices: { message: { content: string; tool_calls?: { function: { name: string; arguments: string } }[] };
        finish_reason: string }[];
      };
      const choice = body.choices[0]!;
      assert.equal(choice.finish_reason, 'tool_calls');
      assert.equal(choice.message.tool_calls?.[0]?.function.name, 'read_file');
      assert.deepEqual(JSON.parse(choice.message.tool_calls?.[0]?.function.arguments ?? '{}'), { path: 'a.ts' });
      // 生の JSON を人に見せない。
      assert.doesNotMatch(choice.message.content, /tool_call|arguments/);
      assert.match(choice.message.content, /見てみます/);
    } finally { await rt.shutdown(); wrapperName = 'QwenChatWrapper'; }
  });

  test('流しているときも、生の JSON を画面へ出さない', async () => {
    const seen: Seen = { history: [], asked: '' };
    wrapperName = 'General';
    const said = 'では<tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}</tool_call>';
    const { rt, baseUrl } = await serve(seen, undefined, said);
    try {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm.gguf', stream: true, tools: TOOLS,
          messages: [{ role: 'user', content: 'a.ts を読んで' }],
        }),
      });
      const got = await readStream(r);
      assert.equal(got.finish, 'tool_calls');
      assert.equal(got.calls[0]?.name, 'read_file');
      assert.doesNotMatch(got.text, /tool_call|arguments/, `生の JSON が出た: ${got.text}`);
    } finally { await rt.shutdown(); wrapperName = 'QwenChatWrapper'; }
  });

  test('型が合うモデルには、これまで通りライブラリ経由で渡す（対）', async () => {
    const seen: Seen = { history: [], asked: '' };
    const { rt, baseUrl } = await serve(seen, { name: 'read_file', args: { path: 'a.ts' } });
    try {
      await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm.gguf', stream: false, tools: TOOLS,
          messages: [{ role: 'user', content: 'a.ts を読んで' }],
        }),
      });
      assert.ok(seen.functions?.read_file, '渡していない');
      assert.doesNotMatch(JSON.stringify(seen.history), /tool_call/, '要らない説明を足している');
    } finally { await rt.shutdown(); }
  });
});
