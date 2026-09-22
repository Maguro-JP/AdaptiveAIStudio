/**
 * 本物の重みで、本当に答えるかを見る。
 *
 * ここまでの確かめは全部、乱数の重みの模型（`tiny-gguf.mjs`）で「道が繋がっている」
 * ことを見ていた。**答えの中身は一度も見ていない。**配った先で毎回そこで壊れた。
 *
 * この命令は、置いてある GGUF（本物）を読んで、二つを**厳しく**見る。
 *
 *   1. 「1+1=」に、本物の文字で 2 と答える（空・時間切れ・壊れた文字・2 でない、は落ちる。
 *      判定は `judgeAnswer`。乱数の模型が偶然 2 を含んで通ったので、含むだけでは通さない）
 *   2. ツールを呼んで読む。`read_file` で置いたマーカーを読み、それを答えに含める
 *      （ツールを呼ばない・呼んでも答えに含めない、は落ちる）
 *
 * 落ちたら終了コード 1。何が返ったかは、そのまま出す（人が読んで判断できるように）。
 *
 * 使い方（作業場でも、配る形の中でも同じ）:
 *   node scripts/real-answer.mjs
 *
 * モデルは設定の保存先（`runtime.modelsDir`、無ければ既定）から、画面と同じ
 * 決め方で選ぶ（`readyLocalModel`）。**乱数の模型（tiny.gguf）では通らない。**
 * それがこの命令の意味。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { askOnce, describeOneTurn, judgeAnswer } from '../src/cli/ask-once.ts';
import { buildRegistry } from '../src/core/build.ts';
import { ChatOrchestrator } from '../src/core/orchestrator.ts';
import { setupAutopilot, resolveCandidates } from '../src/core/autopilot-setup.ts';
import { buildRuntime } from '../src/core/runtime-setup.ts';
import { readyLocalModel } from '../src/core/local-ready.ts';
import { Agent } from '../src/agent/loop.ts';
import { readFileTool } from '../src/agent/tools/fs.ts';
import { Priority } from '../src/providers/contract.ts';

const results = [];
let bad = 0;
async function check(what, run) {
  try {
    const note = await run();
    results.push(`  ok   ${what}${note ? `  ${note}` : ''}`);
  } catch (e) {
    bad += 1;
    results.push(`  NG   ${what}  ${e?.message ?? e}`);
  }
}
const log = (line) => console.log(`       ${line}`);


let config = {};
try { config = loadConfig().config; } catch (e) { console.log(`  設定が読めないので既定で進めます（${e?.message ?? e}）`); }

console.log('AdaptiveAIStudio — 本物の重みで答える\n');

/* ---------- 1. 足し算 ---------- */
await check('1+1= に 2 が返る', async () => {
  const got = await askOnce(config, { log });
  const said = describeOneTurn(got);
  if (!said.ok) throw new Error(said.detail);
  const why = judgeAnswer(got.answer);
  if (why) {
    throw new Error(`${why}。返ってきたもの: 「${got.answer.replace(/\s+/g, ' ').slice(0, 120)}」（${got.model}、${got.answerSeconds.toFixed(1)}秒）`);
  }
  return said.detail;
});

/* ---------- 2. ツールを呼んで読む ---------- */
/*
 * **AI がエディタを使う**は、ここから始まる。モデルが `read_file` を呼び、返った中身を
 * 読んで答える、が本物の重みで通らなければ、その先は全部机上の話になる。
 */
await check('read_file を呼んで、読んだマーカーを答える', async () => {
  const mark = `MARK-${Date.now().toString(36).slice(-5).toUpperCase()}`;
  const root = await mkdtemp(join(tmpdir(), 'aas-real-answer-'));
  await writeFile(join(root, 'secret.txt'), `${mark}\n`);
  const registry = buildRegistry(config);
  const orchestrator = new ChatOrchestrator(registry);
  const pilot = await setupAutopilot(config, registry);
  // 読む側の声も流す（backend・CPU の素性・tok/s）。遅い理由が記録に出るように。
  const runtime = await buildRuntime(config, pilot.machine, log);
  try {
    const ready = await readyLocalModel(config, runtime, log);
    const { candidates } = resolveCandidates(ready.config, pilot);
    if (candidates.length === 0) throw new Error(ready.why ?? '送る先が決まりません');
    const agent = new Agent(orchestrator, {
      candidates,
      system: 'あなたは作業者です。ファイルの中身を訊かれたら、必ず read_file ツールで読んでから、読んだ中身をそのまま答えてください。',
      tools: [readFileTool],
      root,
      maxTurns: 4,
      temperature: 0,
      maxTokens: 256,
      priority: Priority.top,
      approve: async () => true,
      // 答えたら終わり。押し戻し（TASK_DONE を求める）を入れると、答えた後に
      // 「次の一手を」と 2 ターン余計に回して、終わり方が noProgress になる。
      maxNudges: 0,
    });
    const ac = new AbortController();
    const giveUp = setTimeout(() => ac.abort(), 600_000);
    giveUp.unref?.();
    const seen = [];
    let text = '';
    let finished;
    try {
      for await (const ev of agent.run([{ role: 'user', content: 'secret.txt の中身を read_file で読んで、そのまま答えてください。' }], ac.signal)) {
        if (ev.type === 'toolStart') { seen.push(`呼んだ: ${ev.call.name}(${JSON.stringify(ev.call.args)})`); log(seen.at(-1)); }
        else if (ev.type === 'toolEnd') { seen.push(`返った: ${ev.result.slice(0, 80).replace(/\n/g, '⏎')}`); log(seen.at(-1)); }
        else if (ev.type === 'thinking') text += ev.delta;
        else if (ev.type === 'finished') finished = ev;
      }
    } finally { clearTimeout(giveUp); }
    const called = seen.some((s) => s.startsWith('呼んだ: read_file'));
    const shown = text.replace(/\s+/g, ' ').slice(0, 160);
    if (!called) {
      throw new Error(`read_file を呼びませんでした。答え: 「${shown}」 / 終わり方: ${finished?.reason ?? '不明'} ${finished?.detail ?? ''}`);
    }
    if (!text.includes(mark)) {
      throw new Error(`読んだマーカー（${mark}）を答えに含めませんでした。答え: 「${shown}」 / 終わり方: ${finished?.reason ?? '不明'}`);
    }
    return `${candidates[0]} / 呼んで、読んで、答えました（${finished?.reason ?? '不明'}）`;
  } finally {
    await runtime.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

console.log('');
console.log(results.join('\n'));
console.log('');
if (bad > 0) {
  console.log(`  ${bad} 件、通っていません。本物の重みで答えられていません。`);
  process.exit(1);
}
console.log('  通りました。本物の重みで、足し算とツール呼びの 1 ターンが返っています。');
// 通ったときも自分で終わる（`selftest` と同じ）。何かが残って止まると、
// 全部通ったのに CI の上限まで待って赤になる。
process.exit(0);
