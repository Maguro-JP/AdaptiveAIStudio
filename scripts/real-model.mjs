/**
 * 本物のモデルで、中で読む道を通す。
 *
 * **ここまで、中で読む道は一度も本物で動かしていなかった。**
 * 差し替えの試験は通っていたが、それは「差し替えが動く」ことしか言っていない。
 *
 * 網の外からモデルを取ってこられない場所でも確かめられるよう、
 * 最小の GGUF を自分で組んで使う（中身は無意味。乱数の重み）。
 * 見るのは、読める・文脈が作れる・文字が返る・窓を読む、の四つ。
 *
 * node-llama-cpp が無い場所では飛ばす（bundle には入っていない）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  await import('node-llama-cpp');
} catch {
  console.log('飛ばします: node-llama-cpp が入っていません');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'aas-real-'));
const model = join(dir, 'tiny.gguf');
execFileSync(process.execPath, [join(root, 'scripts', 'tiny-gguf.mjs'), model], { stdio: 'pipe' });

const { InProcRuntime } = await import(join(root, 'src', 'runtime', 'inproc.ts'));
const logs = [];
const rt = new InProcRuntime({ modelsDir: dir, port: 0, onLog: (l) => logs.push(l) });

const bad = [];
try {
  const { baseUrl } = await rt.ensureLoaded('tiny.gguf');

  // 1. 窓は、ファイルに書いてあるぶんを使っているか。
  if (!logs.some((l) => l.includes('窓: 2048'))) {
    bad.push(`窓を読んでいない: ${logs.join(' / ')}`);
  }

  // 2. 一往復（まとめて返す道）。
  const once = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'tiny.gguf', stream: false, max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const body = await once.json();
  const said = body?.choices?.[0]?.message?.content;
  if (typeof said !== 'string') bad.push(`まとめて返す道で返事が無い: ${JSON.stringify(body).slice(0, 200)}`);

  // 3. 流して返す道。
  const streamed = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'tiny.gguf', stream: true, max_tokens: 8,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const raw = await streamed.text();
  if (!raw.includes('data: ')) bad.push('流して返す道が SSE になっていない');
  if (!raw.includes('[DONE]')) bad.push('流して返す道が終わっていない');

  // 4. 型が分かるか（分からないなら、道具は本文で渡す道に落ちる）。
  const wrappers = rt.wrappers();
  if (wrappers.length !== 1) bad.push(`読み込んだモデルが数えられていない: ${JSON.stringify(wrappers)}`);
  const guessed = wrappers[0]?.guessed === true;

  // 5. 道具を渡したときに、道が選ばれているか。
  //
  //    型が当てずっぽうなら、**本文で渡す道**に落ちるはず。
  //    そこが繋がっていないと、道具は一度も呼ばれない（画面からは
  //    「動いているが何もしない」に見える）。本物で踏んでおく。
  const withTools = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'tiny.gguf', stream: false, max_tokens: 8,
      messages: [{ role: 'user', content: 'read a.ts' }],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'ファイルを読む',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      }],
    }),
  });
  if (!withTools.ok) {
    bad.push(`道具を渡すと落ちる: ${withTools.status} ${(await withTools.text()).slice(0, 200)}`);
  } else {
    const got = await withTools.json();
    const choice = got?.choices?.[0];
    if (!choice) bad.push(`道具を渡したときに返事が無い: ${JSON.stringify(got).slice(0, 200)}`);
    // 乱数の重みなので、呼び出しは出ない。**落ちないこと**と、
    // 生の JSON を人に見せていないことを見る。
    else if (typeof choice.message?.content !== 'string') {
      bad.push(`返事の形が違う: ${JSON.stringify(choice).slice(0, 200)}`);
    } else if (/tool_call|"arguments"/.test(choice.message.content)) {
      bad.push(`生の呼び出しが本文に出ている: ${choice.message.content.slice(0, 120)}`);
    }
  }
  if (!guessed) {
    console.log('（この模型の型は当てずっぽうではありませんでした。本文で渡す道は踏んでいません）');
  }
} catch (e) {
  bad.push(`落ちました: ${e.message}`);
} finally {
  await rt.shutdown();
  rmSync(dir, { recursive: true, force: true });
}

if (bad.length > 0) {
  console.error(`見つかった不具合 ${bad.length} 件:`);
  for (const b of bad) console.error(`- ${b}`);
  process.exit(1);
}
console.log('本物のモデルで通りました（読み込み・窓・まとめて返す・流して返す・道具を渡す）');
