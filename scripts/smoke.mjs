/*
 * 配った先で、**押す前に一度だけ通す。**
 *
 * この機械（linux）で緑でも、配る先で開くと何も出ない、が続いた。
 * 画面を一つずつ押す `sweep` は Chromium が要るので、配ったものの中では
 * 走らせられない。**同梱の Node だけで通せる形**が要る。
 *
 * 使い方（作業場から）:
 *   npm run smoke
 *
 * 使い方（配ったものの中から。Windows でも同じ）:
 *   runtime\node.exe app\scripts\smoke.mjs
 *
 * 見るのは、今日実際に壊れていた所。立ち上がるか / 使えるかを言えるか /
 * 設定が返るか / 会話が作れるか / 送って断られ方が正しいか。
 * **モデルが無くても通る。**無いなら「無い」と言えることを見る。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * **利用者の記録に書かない。**入口の「4 動くか確かめる」を押すたびに「1+1=」の会話が利用者の履歴に増え、
 * 画面を開いたまま押すと、同じ記録に本体が二つ立っていた。記録のフォルダ（会話・記憶・提案）だけを仮のフォルダへ向け、
 * 終わったら消す。モデル・llama-server・設定は本物を読む（読むだけ。どれも AAS_STATE_DIR に依らない）。
 * 本体を読み込む前に向ける（読み込みの途中でフォルダを決めるものがあっても、仮のほうを見るように）。
 */
const scratch = await mkdtemp(join(tmpdir(), 'aas-smoke-'));
process.env.AAS_STATE_DIR = scratch;
const { UiServer } = await import('../src/ui/server.ts');
const { loadConfig } = await import('../src/config.ts');

/** 答えを待つ上限。モデルを読むところから始まるので、短くしない。 */
// CPU で本物を読むと、読み込みだけで数分かかる。待っている間は進み具合を出す。
const ANSWER_WAIT = 600_000;

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

// 設定が壊れていても、ここで止まらない。壊れていることは doctor が言う。
let config = {};
try { config = loadConfig().config; } catch { /* 既定のまま通す */ }
/*
 * **吐き切るまで待たない。**
 *
 * ここで見たいのは「送って、返って、終わる」道が繋がっていること。
 * 答えの中身は見ていない。既定の `maxTokens`（4096）のままだと、
 * 遅い機械では終わるまでに何分もかかる（CI の Windows で 308 秒、
 * 次の回は 600 秒でも終わらなかった）。**走らせる機械で結果が変わる。**
 * 出す量を短く決めて、時間で落ちないようにする。
 */
config = { ...config, maxTokens: Math.min(config.maxTokens ?? 4096, 32) };
const server = new UiServer({ config, port: 0 });
const base = (await server.start()).replace(/\/$/, '');
const get = (p) => fetch(base + p, { signal: AbortSignal.timeout(30000) });

console.log(`AdaptiveAIStudio — smoke\n  画面: ${base}\n`);

let ready = false;
try {
  await check('画面が出る', async () => {
    const r = await get('/');
    if (!r.ok) throw new Error(`${r.status}`);
    const html = await r.text();
    if (!html.includes('AdaptiveAIStudio')) throw new Error('中身が違う');
    return `${html.length} 文字`;
  });

  await check('使えるかどうかを言える', async () => {
    const r = await get('/api/ready');
    if (!r.ok) throw new Error(`${r.status}`);
    const body = await r.json();
    ready = body.ready === true;
    return ready
      ? 'モデルは用意できています（読むのは頼まれたとき）'
      : `まだ話せません（${(body.why ?? '').split('\n')[0]}）`;
  });

  await check('設定が返る', async () => {
    const r = await get('/api/config');
    if (!r.ok) throw new Error(`${r.status}`);
    const body = await r.json();
    if (!body.kinds?.length) throw new Error('動かし方の一覧が空');
    return `${body.kinds.length} 通り${body.slow ? '（保存先を読むのに時間がかかっています）' : ''}`;
  });

  await check('配置が返る', async () => {
    const r = await get('/api/layout');
    if (!r.ok) throw new Error(`${r.status}`);
    if (!(await r.json()).layout) throw new Error('配置が空');
    return undefined;
  });

  await check('取ってくる先の一覧が出る', async () => {
    // 空の選択肢を出していた（設定 → モデルの「取ってくる」）。空だと、
    // モデルを持っていない人はそこで詰む。名前を直に打つ道は別にある。
    const r = await get('/api/models');
    if (!r.ok) throw new Error(`${r.status}`);
    const body = await r.json();
    if (!Array.isArray(body.catalog) || body.catalog.length === 0) throw new Error('一覧が空');
    return `${body.catalog.length} 件`;
  });

  /*
   * **名前と、見ているものを合わせる。**
   *
   * ここは「会話が作れる」という名前で、一覧が配列かどうかだけを見ていた。
   * 会話はこの口では作らない（最初の一言が来たときに作る）ので、
   * 名前も、見ているものも違う。配列かどうかだけなら**空でも通る**。
   *
   * この口の仕事は「トップへ戻す」。戻ったことと、一覧の数が食い違って
   * いないことを見る。
   */
  await check('新しい会話に戻せる', async () => {
    const made = await fetch(`${base}/api/conversations`, { method: 'POST' });
    if (!made.ok) throw new Error(`戻せない: ${made.status}`);
    const top = await made.json();
    if (top.current !== null) throw new Error(`トップに戻っていない: ${top.current}`);
    if (!Array.isArray(top.messages) || top.messages.length > 0) throw new Error('やりとりが残っている');
    const list = await (await get('/api/conversations')).json();
    if (!Array.isArray(list.list)) throw new Error('一覧が返らない');
    if (typeof list.total !== 'number') throw new Error('総数が返らない');
    if (list.list.length > list.total) throw new Error(`総数が合わない: ${list.list.length} > ${list.total}`);
    if (list.current !== null) throw new Error(`戻したのに開いている: ${list.current}`);
    return `${list.total} 件（出しているのは ${list.list.length} 件）`;
  });

  await check('送ったときの返り方', async () => {
    const r = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '1+1=' }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await r.json().catch(() => ({}));
    if (ready) {
      if (r.status !== 202) throw new Error(`受け取られない: ${r.status} ${body.error ?? ''}`);
      return '受け取りました';
    }
    // モデルが無いなら、断られるのが正しい。**黙って落ちないこと**が要点。
    if (r.status !== 503) throw new Error(`断り方が違う: ${r.status}`);
    if (!body.error) throw new Error('断ったのに理由が無い');
    return `正しく断りました（${body.error.split('\n')[0]}）`;
  });
  /*
   * **受け取ったところで止めない。**返ってくるまでを見る。
   *
   * 「立ち上がった」を「使える」として報告して、開いた先で壊れているのが
   * 見つかる、を繰り返した。送って、返って、終わるところまでを一続きで見る。
   * モデルを読むのに時間がかかるので、上限を置いて、届かなければそう言う。
   */
  if (ready) {
    await check('返ってくる', async () => {
      const began = Date.now();
      const events = await fetch(`${base}/api/events`, { signal: AbortSignal.timeout(ANSWER_WAIT) });
      const reader = events.body.getReader();
      const dec = new TextDecoder();
      let text = '';
      let done = false;
      let raw = '';
      try {
        while (!done && Date.now() - began < ANSWER_WAIT) {
          const { value, done: end } = await reader.read();
          if (end) break;
          raw += dec.decode(value, { stream: true });
          const parts = raw.split('\n');
          raw = parts.pop() ?? '';
          for (const line of parts) {
            if (!line.startsWith('data:')) continue;
            const v = JSON.parse(line.slice(5).trim());
            if (v.type === 'session' && v.event?.type === 'text') text += v.event.delta ?? '';
            if (v.type === 'log' && /^(読み込み中|モデルを読み込んでいます|まだ読み込んでいます|読み込みました|読み込めませんでした|モデルのプロセスが落ちました)/.test(v.text ?? '')) {
              console.log(`       ${v.text.split('\n')[0]}`);
            }
            if (v.type === 'session' && v.event?.type === 'log' && v.event.level === 'error') throw new Error(v.event.text);
            if (v.type === 'busy' && v.busy === false && text.length > 0) done = true;
          }
        }
      } finally { await reader.cancel().catch(() => undefined); }
      if (!done && text.length === 0) {
        throw new Error(`${Math.round(ANSWER_WAIT / 1000)} 秒待っても、何も返ってきません`);
      }
      return `${text.length} 文字返りました（${Math.round((Date.now() - began) / 1000)} 秒）`;
    });
  }
} finally {
  await server.stop().catch(() => undefined);
  try { await rm(scratch, { recursive: true, force: true }); } catch { /* 消せない仮のフォルダ。temp の中なので、OS の片づけに任せる */ }
}

console.log(results.join('\n'));
console.log('');
if (bad > 0) {
  console.log(`  ${bad} 件、通っていません。この画面をそのまま渡してください。`);
  process.exit(1);
}
console.log(ready
  ? '  通りました。送って、返るところまで見ています（答えの中身は見ていません）。'
  : '  通りました。モデルはまだ置いていないので、そこは「無い」と言えることまでの確認です。');
