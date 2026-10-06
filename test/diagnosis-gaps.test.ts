/**
 * 困ったときの入口（doctor・報告）の不具合（54 回目の調査）。
 *
 * - doctor の画面とファイルが、外のツールの道の問い合わせ（`?api_key=…`）や命令の引数の鍵を、伏せずに出していた
 * - 遠くの外のツールの `headersFrom` が環境に無くても、ok と言っていた
 * - OpenAI 互換の接続を鍵を付けずに確かめ、鍵を正しく置いても「HTTP 401」と出していた
 *
 * 報告の保存先・逃がした保存先の表示・書き込みの確かめの名前・AAS_UI_PORT は、入口の中の直しで、ここでは試験を書いていない。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { installRoot } from '../src/core/home.ts';
import { needsStripFlag } from '../src/core/node-flags.ts';
import { cleanAasEnv } from './env.ts';

const QUERY_KEY = 'abcdefghijklmnopqrst';
const ARG_KEY = 'sk-' + 'Q'.repeat(30);
const BEARER = 'bearer-value-for-test';

let server: Server;
let base = '';

before(async () => {
  // 鍵を付けて訊いたときだけ 200 を返す
  server = createServer((req, res) => {
    res.writeHead(req.headers.authorization === `Bearer ${BEARER}` ? 200 : 401, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
after(async () => { await new Promise<void>((ok) => server.close(() => ok())); });

async function runDoctor(env: Record<string, string>): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const at = join(installRoot(), 'src', 'cli', 'doctor.ts');
  const flags = needsStripFlag(process.versions.node) ? ['--experimental-strip-types'] : [];
  const out = await run(process.execPath, [...flags, '--no-warnings', at], {
    env: cleanAasEnv({ ...env, NO_COLOR: '1' }), timeout: 300_000,
  }).catch((e: { stdout?: string; stderr?: string }) => e);
  // eslint-disable-next-line no-control-regex
  return `${out.stdout ?? ''}${out.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('doctor', { timeout: 320_000 }, () => {
  test('**鍵を伏せ、見出しのトークンの不足を言い、鍵を付けて繋ぎ先を確かめる**', async () => {
    const home = await tempDir('aas-diag-home-');
    const reports = await tempDir('aas-diag-reports-');
    await mkdir(join(home, 'models'), { recursive: true });
    const config = join(home, 'aas.config.json');
    await writeFile(config, JSON.stringify({
      providers: [{ id: 'remote', kind: 'openai-compatible', baseUrl: base, locality: 'cloud', apiKeyEnv: 'AAS_TEST_BEARER', models: ['m'] }],
      candidates: ['remote:m'],
      runtime: { kind: 'none' },
      mcp: { servers: {
        notion: { url: `https://mcp.example/?api_key=${QUERY_KEY}&v=1`, headersFrom: { Authorization: 'AAS_TEST_NOTION_TOKEN' } },
        local: { command: process.execPath, args: ['--api-key', ARG_KEY] },
      } },
    }));
    const text = await runDoctor({ AAS_HOME: home, AAS_CONFIG: config, AAS_REPORT_DIR: reports, AAS_TEST_BEARER: BEARER });
    assert.doesNotMatch(text, new RegExp(QUERY_KEY), '道の問い合わせの鍵を画面に出した');
    assert.doesNotMatch(text, new RegExp(ARG_KEY), '引数の鍵を画面に出した');
    assert.match(text, /トークンが環境にありません: AAS_TEST_NOTION_TOKEN/, '見出しのトークンの不足を言っていない');
    assert.match(text, /接続 \(remote\)[^\n]*HTTP 200/, `鍵を付けずに確かめた:\n${text.split('\n').filter((l) => /接続/.test(l)).join('\n')}`);
    const files = await readdir(reports);
    assert.ok(files.length > 0, '前提: 報告が残っていない');
    for (const f of files) {
      const body = await readFile(join(reports, f), 'utf8');
      assert.doesNotMatch(body, new RegExp(`${QUERY_KEY}|${ARG_KEY}`), `報告のファイルに鍵を残した: ${f}`);
    }
  });
});

describe('報告のファイル', () => {
  test('**送ってもらうファイルは、秘密を伏せてから書く**', async () => {
    const { saveReport } = await import('../src/cli/report-file.ts');
    const dir = await tempDir('aas-diag-save-');
    const before = process.env.AAS_REPORT_DIR;
    delete process.env.AAS_REPORT_DIR;
    try {
      const saved = await saveReport('doctor', `接続 GITHUB_TOKEN=ghp_${'A'.repeat(36)}\n`, [dir]);
      assert.ok(saved.path);
      assert.doesNotMatch(await readFile(saved.path!, 'utf8'), /ghp_A{36}/, '鍵を伏せずに書いた');
    } finally {
      if (before !== undefined) process.env.AAS_REPORT_DIR = before;
    }
  });
});
