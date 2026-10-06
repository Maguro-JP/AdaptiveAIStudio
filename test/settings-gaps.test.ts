/**
 * 77 回目の不具合調査（画面から設定を変える道）の分。
 *
 * - 繋ぎ直しは、前に保存した形（手元か遠くか）と、触らない項目を保つ
 * - 外の環境変数に同じ名前が立っていれば、立ち上げ直すとそちらが使われると言う
 * - 設定と .env の書き込みは、別のプロセスとも並ぶ（錠が取れなければ書かない）
 *
 * 画面の JS の直し（起こせなかった知らせ・色のダイアログの開き直し・保存の知らせの順）は、ここでは確かめていない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import * as connect from '../src/core/mcp-connect.ts';

async function inBox(config?: unknown): Promise<string> {
  const home = await tempDir('aas-settings-gaps-');
  process.env.AAS_HOME = home;
  process.env.AAS_CONFIG = join(home, 'aas.config.json');
  if (config !== undefined) await writeFile(process.env.AAS_CONFIG, JSON.stringify(config));
  return home;
}
const saved = async (): Promise<{ mcp: { servers: Record<string, Record<string, unknown>> } }> =>
  JSON.parse(await readFile(process.env.AAS_CONFIG!, 'utf8'));

describe('繋ぎ直す', () => {
  test('**手元で動かす形で繋いだものは、繋ぎ直しても手元のまま。手で足した項目も残す**', async () => {
    await inBox({ mcp: { servers: { notion: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], startupTimeoutMs: 60000 } } } });
    const got = await connect.connectService('notion');
    assert.equal(got.ok, true, got.error);
    const spec = (await saved()).mcp.servers.notion!;
    assert.equal(spec.url, undefined, `遠くの形に戻した: ${JSON.stringify(spec)}`);
    assert.equal(spec.command, 'npx');
    assert.equal(spec.startupTimeoutMs, 60000, `手で足した項目が消えた: ${JSON.stringify(spec)}`);
  });

  test('前に何も無ければ、これまでどおり遠くの形（対）', async () => {
    await inBox();
    const got = await connect.connectService('notion');
    assert.equal(got.ok, true, got.error);
    assert.equal(typeof (await saved()).mcp.servers.notion!.url, 'string');
  });
});

describe('外の環境変数', () => {
  test('**同じ名前が外で立っていれば、立ち上げ直すとそちらが使われると言う（値は出さない）**', async () => {
    await inBox();
    const prev = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'old-outside-value';
    try {
      const got = await connect.connectService('github', { secrets: { GITHUB_TOKEN: 'new-value' } });
      assert.equal(got.ok, true, got.error);
      const said = got.notes.join('\n');
      assert.match(said, /環境変数 GITHUB_TOKEN が別に立っています/, said);
      assert.doesNotMatch(said, /old-outside-value|new-value/, '値を出している');
    } finally {
      if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev;
    }
  });
});

describe('別のプロセスとの並び', () => {
  test('**ほかのプロセスが設定の錠を持っている間は、書かない**', async () => {
    await inBox({ keep: 1 });
    // 今できたばかりの錠（古くないので消されない）
    await writeFile(`${process.env.AAS_CONFIG}.lock`, `${process.pid} other`);
    const got = await connect.connectService('context7');
    assert.equal(got.ok, false, '錠を無視して書いた');
    assert.deepEqual(JSON.parse(await readFile(process.env.AAS_CONFIG!, 'utf8')), { keep: 1 });
  });
});
