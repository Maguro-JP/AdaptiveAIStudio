/**
 * 一度「この依頼は以降訊かない」と答えたら、同じ依頼のあいだは訊き直さない。
 *
 * 5 ファイル直すと 5 回訊かれる。1 回目で中身を見て納得しているのに、
 * 残り 4 回も同じ手を動かすことになる。人はそこで**中身を見ずに押す**
 * ようになり、承認そのものが形だけになる。
 *
 * 効くのは書き込みだけ。効くのはその依頼のあいだだけ。
 *
 * **このテストだけで一つのファイルにする。**記録の保存先を他と分けないと、
 * 前のテストの会話が続きとして載る（`approve-write.test.ts` と同じ理由）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-approve-all-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

let fake: FakeServer;
let srv: InstanceType<typeof UiServer>;
let url = '';
let work = '';

before(async () => {
  work = await tempDir('aas-approve-all-work-');
  await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, 'src', 'a.txt'), 'もとの a\n');
  await writeFile(join(work, 'src', 'b.txt'), 'もとの b\n');
  await writeFile(join(work, 'package.json'), JSON.stringify({
    name: 'x', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' },
  }));
  fake = await startFakeServer({
    kind: 'steps',
    // **読んでから書く。**規則がその並びを求める。
    calls: [
      { name: 'read_file', args: { path: 'src/a.txt' } },
      { name: 'write_file', args: { path: 'src/a.txt', content: '直した a\n' } },
      { name: 'read_file', args: { path: 'src/b.txt' } },
      { name: 'write_file', args: { path: 'src/b.txt', content: '直した b\n' } },
    ],
    then: '2 つ直しました。',
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

/** 1ターン。最初の承認にだけ答え、何回訊かれたかを数える。 */
async function turn(first: { approved: boolean; all?: boolean }): Promise<number> {
  const ac = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let asked = 0;
  let ended = false;

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
            const ev = JSON.parse(line.slice(6)) as { type?: string; id?: string; busy?: boolean };
            if (ev.type === 'approval') {
              asked += 1;
              // 2 回目以降が来たら、そこで拒否する（来ないのが正しい）。
              const body = asked === 1
                ? { id: ev.id, approved: first.approved, ...(first.all ? { all: true } : {}) }
                : { id: ev.id, approved: false };
              await fetch(`${url}/api/approve`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
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
    body: JSON.stringify({ text: '2 つ直して' }),
  });

  const deadline = Date.now() + 60_000;
  while (!ended && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  await pump;
  return asked;
}

describe('この依頼は以降訊かない', () => {
  test('**2 つ目は訊かれず、どちらも書き換わる**', async () => {
    const asked = await turn({ approved: true, all: true });
    assert.equal(asked, 1, `${asked} 回訊かれた（1 回のはず）`);
    assert.equal(await readFile(join(work, 'src', 'a.txt'), 'utf8'), '直した a\n');
    assert.equal(await readFile(join(work, 'src', 'b.txt'), 'utf8'), '直した b\n');
  });

  test('**次の依頼では、また訊く**', async () => {
    // 持ち越すと、一度押しただけで以後ずっと素通りになる。
    await writeFile(join(work, 'src', 'a.txt'), 'もとの a\n');
    await writeFile(join(work, 'src', 'b.txt'), 'もとの b\n');
    await fetch(`${url}/api/conversations`, { method: 'POST' });
    const asked = await turn({ approved: false });
    assert.ok(asked >= 1, '次の依頼で訊いてこない（持ち越している）');
    assert.equal(await readFile(join(work, 'src', 'a.txt'), 'utf8'), 'もとの a\n',
      '拒否したのに書き換わっている');
  });
});
