/**
 * **外した塊を、押し場所によって黙って通さない。**
 *
 * 塊ごとのチェックを外してから「この依頼は以降訊かない」を押すと、画面は塊の番号を
 * 送らず、本体は `'all'`（全部通す）として扱って**全文を書いていた。**
 * 画面には「許可（この依頼は以降訊かない）」と出るので、外したはずの直しが
 * 入ったことに気づけない。
 *
 * ここでは画面の口（`/api/approve`）へ、チェックを外した形（`hunks` と `all` の
 * 両方）を送って、**選んだ塊だけが書かれ、次のファイルは訊かれない**ことを見る。
 *
 * **この試験だけで一つのファイルにする。**記録の保存先を他と分けないと、
 * 前の試験の会話が続きとして載る（`approve-all.test.ts` と同じ理由）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-partial-all-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

// 2 か所を、離して直す（差分が 2 つの塊に割れる形）。
const BEFORE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const AFTER = ['FIRST', ...Array.from({ length: 10 }, (_, i) => `line ${i + 2}`), 'LAST'].join('\n') + '\n';
/** 前の塊だけを通したときに出来る中身。 */
const ONLY_FIRST = ['FIRST', ...Array.from({ length: 11 }, (_, i) => `line ${i + 2}`)].join('\n') + '\n';

let fake: FakeServer;
let srv: InstanceType<typeof UiServer>;
let url = '';
let work = '';

before(async () => {
  work = await tempDir('aas-partial-all-work-');
  await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, 'src', 'a.txt'), BEFORE);
  await writeFile(join(work, 'src', 'b.txt'), 'もとの b\n');
  await writeFile(join(work, 'package.json'), JSON.stringify({
    name: 'x', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' },
  }));
  fake = await startFakeServer({
    kind: 'steps',
    calls: [
      { name: 'read_file', args: { path: 'src/a.txt' } },
      { name: 'write_file', args: { path: 'src/a.txt', content: AFTER } },
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

/** 1ターン。最初の承認に「前の塊だけ・以降訊かない」で答え、訊かれた回数と配られた差分を返す。 */
async function turn(): Promise<{ asked: number; diffs: Array<{ path: string; diff: string }> }> {
  const ac = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let asked = 0;
  let ended = false;
  const diffs: Array<{ path: string; diff: string }> = [];

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
              type?: string; id?: string; busy?: boolean;
              event?: { type?: string; path?: string; diff?: string };
            };
            // 画面へ配られた差分。**書いたものと同じであること**を後で見る。
            if (ev.type === 'session' && ev.event?.type === 'diff') {
              diffs.push({ path: String(ev.event.path ?? ''), diff: String(ev.event.diff ?? '') });
            }
            if (ev.type === 'approval') {
              asked += 1;
              // 1 回目だけ答える。2 回目が来たら拒否する（来ないのが正しい）。
              const body = asked === 1
                ? { id: ev.id, approved: true, hunks: [0], all: true }
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
  return { asked, diffs };
}

describe('塊を選んでから「以降訊かない」', () => {
  test('**外した塊は書かれず、次のファイルは訊かれない**', async () => {
    const { asked, diffs } = await turn();
    assert.equal(await readFile(join(work, 'src', 'a.txt'), 'utf8'), ONLY_FIRST,
      '外した塊まで書いている（または選んだ塊が書かれていない）');
    assert.equal(asked, 1, `${asked} 回訊かれた（1 回のはず）`);
    assert.equal(await readFile(join(work, 'src', 'b.txt'), 'utf8'), '直した b\n',
      '「以降訊かない」が効いていない');

    /*
     * **画面へ配る差分は、書いたものと同じにする。**
     *
     * ここは承認のときに拾った「提案そのまま」を配っていたので、通さなかった
     * 塊まで札に並び、そこの「戻す」は当たらずに断られていた。
     */
    const forA = diffs.filter((d) => d.path.endsWith('a.txt'));
    assert.equal(forA.length, 1, `a.txt の差分が ${forA.length} 件（1 件のはず）`);
    assert.match(forA[0]!.diff, /\+FIRST/, `通した塊が差分に無い: ${forA[0]!.diff}`);
    assert.doesNotMatch(forA[0]!.diff, /\+LAST/, `通していない塊が差分に並んでいる: ${forA[0]!.diff}`);
  });
});
