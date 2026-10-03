/**
 * 画面の口から書き換える。**承認を通して、本当にファイルが変わるまで。**
 *
 * 出来事だけを見ていたので、規則に止められて何も変わっていないのに
 * 「完了」と出ていたのに気づけなかった。ここは結果（ファイルの中身）で判じる。
 *
 * **この検査だけで一つのファイルにする。**記録の置き場を他と分けないと、
 * 前の検査の会話が続きとして載り、偽の相手が「もう道具は呼び終えた」と
 * 判じて、いきなり答えを返す（実際にそうなった）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-approve-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

let fake: FakeServer;
let srv: InstanceType<typeof UiServer>;
let url = '';
let work = '';
/** 承認を待っている間に `/api/approvals` が、その承認と「動いている」を返したか。 */
let listed = false;
/** 届いた承認の名前。 */
let approvalId = '';

before(async () => {
  work = await tempDir('aas-approve-work-');
  await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, 'src', 'a.txt'), 'もとの中身\n');
  await writeFile(join(work, 'package.json'), JSON.stringify({
    name: 'x', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' },
  }));
  fake = await startFakeServer({
    kind: 'steps',
    // **読んでから書く。**規則がその並びを求める。読まずに書くと弾かれる。
    calls: [
      { name: 'read_file', args: { path: 'src/a.txt' } },
      { name: 'write_file', args: { path: 'src/a.txt', content: '書き換えました\n' } },
    ],
    then: '書き換えました。',
  });
  srv = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
      agent: { root: work, approval: 'ask' },
    } as typeof DEFAULT_CONFIG,
  });
  url = (await srv.start()).replace(/\/$/, '');
});
after(async () => { await srv.stop(); await fake.close(); });

/**
 * 一往復。承認を求められたら答える。
 *
 * 読む側は**先に走らせておく**。送ってから読み始めると、
 * 承認の問い合わせを読み落として、いつまでも答えないことになる。
 */
async function turn(approved: boolean): Promise<{ asked: boolean; types: string[] }> {
  const ac = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const types: string[] = [];
  let asked = false;
  let ended = false;
  listed = false;
  approvalId = '';

  const pump = (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const ev = JSON.parse(line.slice(6)) as {
              type?: string; id?: string; busy?: boolean; event?: { type?: string };
            };
            types.push(ev.type === 'session' ? `s/${ev.event?.type}` : String(ev.type));
            if (ev.type === 'approval' && !asked) {
              asked = true;
              // 待っている承認は、流れの外からも取れる（繋ぎ直した画面・開き直した画面が出し直す）
              const waiting = await (await fetch(`${url}/api/approvals`)).json() as { approvals: Array<{ id: string }>; busy: boolean };
              listed = waiting.approvals.some((a) => a.id === ev.id) && waiting.busy;
              approvalId = String(ev.id);
              await fetch(`${url}/api/approve`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: ev.id, approved }),
              });
            }
            if (ev.type === 'busy' && ev.busy === false) ended = true;
          }
        }
      }
    } catch { /* 打ち切り */ }
  })();

  await fetch(`${url}/api/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'src/a.txt を書き換えて' }),
  });

  const deadline = Date.now() + 60_000;
  while (!ended && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  await pump;
  return { asked, types };
}

describe('画面から書き換える', () => {
  test('拒否したら、ファイルは変わらない', async () => {
    const r = await turn(false);
    assert.ok(r.asked, `承認を求めてこない（黙って書き換えている）: ${r.types.join(',')}`);
    assert.ok(listed, '待っている承認を /api/approvals が返さない');
    // 起動ごとのタグが付く。番号だけだと、立ち上げ直す前の画面の箱が、立ち上げ直した後の別の承認を通す
    assert.match(approvalId, /^a[0-9a-f]{8}-\d+$/, `承認の名前に起動ごとのタグが無い: ${approvalId}`);
    assert.equal(await readFile(join(work, 'src', 'a.txt'), 'utf8'), 'もとの中身\n',
      '拒否したのに書き換わっている');
  });

  test('許可したら、ファイルが変わる（対）', async () => {
    // 続きにすると、偽の相手が「もう道具は呼び終えた」と判じる。新しい会話から。
    await fetch(`${url}/api/conversations`, { method: 'POST' });
    const r = await turn(true);
    assert.ok(r.asked, `承認を求めてこない: ${r.types.join(',')}`);
    assert.equal(await readFile(join(work, 'src', 'a.txt'), 'utf8'), '書き換えました\n',
      '許可したのに書き換わっていない');
    // 作業後の検査まで回っていること。書いて終わりにしない。
    assert.ok(r.types.includes('s/verify'), `作業後の検査が回っていない: ${r.types.join(',')}`);
  });
});
