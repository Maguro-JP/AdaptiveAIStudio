/**
 * README に載せる画面の例を撮り直す。
 *
 *   node scripts/shot.mjs [撮る先.png]
 *
 * **画面を変えたら撮り直す。**古い画像は、直したはずの所を古いまま見せる。
 * 撮るのは見本のプロジェクト（ここで作る）で、モデルは**この場で立てる偽物**。
 * 本物のモデルは要らないし、撮るたびに答えが変わることもない。
 *
 * 走らせるには playwright-core と Chromium が要る（bundle には入れない）。
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { findBrowser } from './find-browser.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shot = process.argv[2] ?? join(root, 'docs', 'images', 'main-screen.png');
const port = Number(process.env.AAS_SHOT_PORT ?? 4193);

/** 見本のプロジェクト。**実データを写さない。** */
const SAMPLE = {
  'hello.ts': '/** 挨拶を作る。名前を渡さなければ、世界に挨拶する。 */\n'
    + 'export function greet(name?: string): string {\n'
    + "  return `こんにちは、${name ?? '世界'}。`;\n"
    + '}\n\n'
    + 'export function main(): void {\n'
    + '  console.log(greet());\n'
    + '}\n',
  'README.md': '# sample-project\n\n画面の例を撮るための、小さな見本です。\n',
  'notes.md': '# メモ\n\n- greet に名前を渡せるようにする\n- テストを足す\n',
};

/** 偽のモデル。一度 read_file を呼び、次で短く答えて終わる。 */
function fakeModel() {
  let asked = 0;
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"local-model"}]}');
    }
    req.on('data', () => undefined);
    req.on('end', () => {
      asked += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (asked === 1) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"hello.ts"}' } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        const text = 'hello.ts を読みました。`greet` は名前を受け取れるので、'
          + '呼び出し側で渡せば挨拶に名前が入ります。テストも書き足しますか。\nTASK_DONE\n';
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return server;
}

const picked = findBrowser({ platform: process.platform, env: process.env, exists: existsSync });
if (!picked.ok) { console.error(picked.why); process.exit(2); }

/*
 * 場所は毎回同じにする。**撮った画像に道が写る**ので、`mkdtemp` の乱数が
 * 入ると撮り直すたびに違う字が出る（差分が画像ごと入れ替わる）。
 */
const base = join(tmpdir(), 'aas-shot');
const work = join(base, 'sample-project');
const home = join(base, 'home');
await rm(base, { recursive: true, force: true }).catch(() => undefined);
await mkdir(work, { recursive: true });
await mkdir(home, { recursive: true });
for (const [name, body] of Object.entries(SAMPLE)) await writeFile(join(work, name), body);

const model = fakeModel();
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const mport = model.address().port;
await writeFile(join(home, 'aas.config.json'), JSON.stringify({
  providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${mport}/v1`, locality: 'local', models: ['local-model'] }],
  candidates: ['local:local-model'],
  runtime: { kind: 'ollama' },
  agent: { root, approval: 'auto' },
  initiative: { enabled: false },
}, null, 2).replace(JSON.stringify(root), JSON.stringify(work)));

const ui = spawn(process.execPath, [join(root, 'src', 'cli', 'ui.ts')], {
  env: { ...process.env, AAS_HOME: home, AAS_CONFIG: join(home, 'aas.config.json'), AAS_UI_PORT: String(port) },
  stdio: 'inherit',
});
await new Promise((r) => setTimeout(r, 7000));

const b = await chromium.launch({ executablePath: picked.browser });
const p = await b.newPage({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2 });
let failed = '';
try {
  // 通信が止むのを待たない（`/api/events` が開きっぱなしで止まない）。
  // 本体と繋がったのを待つ。理由は scripts/sweep.mjs の `opened`。
  await p.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await p.waitForSelector('#status.live', { timeout: 30_000 });
  await p.waitForTimeout(1500);
  const file = p.locator('#sideFiles button').filter({ hasText: 'hello.ts' }).first();
  if (await file.count() === 0) throw new Error('見本のファイルが一覧に出ない');
  await file.click();
  await p.waitForTimeout(1200);
  await p.locator('.chat textarea').fill('hello.ts の greet に名前を渡したいです。どうすればいいですか。');
  await p.locator('.chat button', { hasText: '送る' }).first().click();
  // 答えが出るまで待つ（出ないまま撮ると、空の画面を載せることになる）。
  await p.waitForFunction(() => document.querySelector('.chat')?.innerText?.includes('読みました'), null, { timeout: 30000 });
  await p.waitForTimeout(800);
  // 指した所が光らないように、どこも指していない所へ動かす。
  await p.mouse.move(700, 430);
  await p.waitForTimeout(300);
  await p.screenshot({ path: shot });
  console.log(`撮りました: ${shot}`);
} catch (e) {
  failed = String(e?.message ?? e);
} finally {
  await b.close();
  ui.kill();
  model.close();
  await rm(base, { recursive: true, force: true }).catch(() => undefined);
}
if (failed) { console.error(`撮れませんでした: ${failed}`); process.exit(1); }
