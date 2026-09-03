/**
 * 画面から GitHub を繋ぐところ。
 *
 * 合言葉は**置き場の .env** に書き、設定にはその**名前だけ**を書く。
 * 画面にも返事にも、値そのものは出さない。
 *
 * 本物の GitHub（npx と網）はここでは使わない。使うと、検査が網に縛られる。
 * **本物で通ることは別に確かめた**（2026-09-03、この場所）:
 *   繋ぐ → 次の依頼で npx @modelcontextprotocol/server-github が立ち上がり
 *   道具 26 件 → 会話から github__search_repositories を呼び、GitHub まで届いた
 *   （返事は Bad credentials。この場所の合言葉が PAT ではないため）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const home = await tempDir('aas-ghcfg-');
process.env.AAS_HOME = home;
process.env.AAS_STATE_DIR = home;
process.env.AAS_CONFIG = join(home, 'aas.config.json');
delete process.env.GITHUB_TOKEN;

const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

let srv: InstanceType<typeof UiServer>;
let url = '';

before(async () => {
  srv = new UiServer({ port: 0, config: { ...DEFAULT_CONFIG } });
  url = (await srv.start()).replace(/\/$/, '');
});
after(async () => { await srv.stop(); });

describe('画面から GitHub を繋ぐ', () => {
  test('繋ぐ前は、何も無いと言う', async () => {
    const d = await (await fetch(`${url}/api/mcp`)).json() as { servers: unknown[]; envPath: string };
    assert.deepEqual(d.servers, []);
    assert.ok(d.envPath.endsWith('.env'), d.envPath);
  });

  test('繋ぐと、合言葉は .env、設定には名前だけ', async () => {
    const r = await fetch(`${url}/api/mcp/github`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'ghp_dummy_value', enabled: true }),
    });
    const body = await r.json() as { path: string; tokenSet: boolean };
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.tokenSet, true);
    // **値は返さない。**
    assert.ok(!JSON.stringify(body).includes('ghp_dummy_value'), '合言葉を返している');

    // 置き場の .env に入っていること。
    const env = await readFile(join(home, '.env'), 'utf8');
    assert.match(env, /GITHUB_TOKEN=ghp_dummy_value/);

    // 設定には名前だけ。値は書かない。
    const cfg = await readFile(join(home, 'aas.config.json'), 'utf8');
    assert.ok(!cfg.includes('ghp_dummy_value'), '設定に合言葉そのものを書いている');
    const parsed = JSON.parse(cfg) as { mcp: { servers: Record<string, { command: string; envFrom: Record<string, string> }> } };
    assert.equal(parsed.mcp.servers.github?.command, 'npx');
    assert.equal(parsed.mcp.servers.github?.envFrom.GITHUB_PERSONAL_ACCESS_TOKEN, 'GITHUB_TOKEN');
  });

  test('繋いだあとの状態に、合言葉の値は出さない', async () => {
    const d = await (await fetch(`${url}/api/mcp`)).json() as {
      servers: Array<{ name: string; secrets: Array<{ name: string; set: boolean }>; tried: boolean }>;
    };
    const gh = d.servers.find((s) => s.name === 'github');
    assert.ok(gh, '一覧に出ていない');
    assert.deepEqual(gh.secrets, [{ name: 'GITHUB_TOKEN', set: true }]);
    assert.ok(!JSON.stringify(d).includes('ghp_dummy_value'), '状態に合言葉が混じっている');
    // **まだ試していない**のと**試して駄目だった**を分ける。
    assert.equal(gh.tried, false, 'まだ立ち上げていないのに、試したことになっている');
  });

  test('合言葉に改行を混ぜて、別の行を足させない', async () => {
    const r = await fetch(`${url}/api/mcp/github`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'x\nEVIL=1', enabled: true }),
    });
    assert.equal(r.status, 400);
    const env = await readFile(join(home, '.env'), 'utf8');
    assert.ok(!env.includes('EVIL'), '別の合言葉を足せてしまう');
  });
});
