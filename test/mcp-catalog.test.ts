/**
 * 繋ぎ先の見本帳と、そこから一つ繋ぐところ。
 *
 * 「MCP に対応しています」は、**名前を一つ言えば繋がる**まで行って初めて
 * 意味がある。ここでは、書かれる形が正しいこと、合言葉が値のまま
 * 設定へ漏れないこと、足りないものを黙らないことを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { CATALOG, findEntry, specFrom, missingSecrets } from '../src/mcp/catalog.ts';
import * as connectMod from '../src/core/mcp-connect.ts';

describe('見本帳', () => {
  test('id が重なっていない', () => {
    const ids = CATALOG.map((e) => e.id);
    assert.deepEqual([...new Set(ids)].sort(), [...ids].sort());
  });

  test('どれも、立ち上げるものか繋ぎ先のどちらかを持つ', () => {
    for (const e of CATALOG) {
      assert.ok(e.command || e.url, `${e.id} は、どうやって繋ぐか書かれていない`);
    }
  });

  test('合言葉は、渡す名前と環境の名前を両方持つ', () => {
    for (const e of CATALOG) {
      const wants = [...Object.values(e.envFrom ?? {}), ...Object.values(e.headersFrom ?? {})];
      for (const from of wants) {
        assert.ok((e.secrets ?? []).some((s) => s.env === from),
          `${e.id}: ${from} を渡すのに、何を入れるものか書かれていない`);
      }
    }
  });

  test('名前でも id でも引ける', () => {
    assert.equal(findEntry('github')?.id, 'github');
    assert.equal(findEntry('GitHub')?.id, 'github');
    assert.equal(findEntry('  Playwright ')?.id, 'playwright');
    assert.equal(findEntry('いない'), undefined);
  });

  test('遠くの相手は、繋ぎ先と見出しの名前だけになる', () => {
    const spec = specFrom(findEntry('github')!);
    assert.equal(spec.url, 'https://api.githubcopilot.com/mcp/');
    assert.equal(spec.headersFrom?.Authorization, 'GITHUB_TOKEN');
    assert.equal(spec.command, undefined);
  });

  test('場所が要る道具には、作業場を入れてやる（書かせない）', () => {
    const spec = specFrom(findEntry('filesystem')!, { root: '/tmp/here' });
    assert.equal(spec.args?.[spec.args.length - 1], '/tmp/here');
  });

  test('足りない合言葉を数える。空文字は「入っている」に数えない', () => {
    const gh = findEntry('github')!;
    assert.deepEqual(missingSecrets(gh, {}).map((s) => s.env), ['GITHUB_TOKEN']);
    assert.deepEqual(missingSecrets(gh, { GITHUB_TOKEN: '  ' }).map((s) => s.env), ['GITHUB_TOKEN']);
    assert.deepEqual(missingSecrets(gh, { GITHUB_TOKEN: 'x' }), []);
  });
});

describe('繋ぐ', () => {
  /** 置き場を切り替える。置き場は呼ぶたびに見るので、読み込み直しは要らない。 */
  async function inBox(): Promise<{ home: string; connect: typeof connectMod }> {
    const home = await tempDir('aas-mcp-');
    process.env.AAS_HOME = home;
    process.env.AAS_CONFIG = join(home, 'aas.config.json');
    return { home, connect: connectMod };
  }

  test('設定に書かれる。合言葉は名前だけで、値は書かれない', async () => {
    const { home, connect } = await inBox();
    const got = await connect.connectService('github', { secrets: { GITHUB_TOKEN: 'ghp_ひみつ' } });
    assert.equal(got.ok, true, got.error);

    const written = await readFile(join(home, 'aas.config.json'), 'utf8');
    assert.match(written, /api\.githubcopilot\.com/);
    assert.match(written, /GITHUB_TOKEN/);
    // **値は設定に出さない。**出すと、設定ごと人に見せられなくなる。
    assert.doesNotMatch(written, /ghp_ひみつ/, `合言葉が設定に漏れている:\n${written}`);

    // 値は置き場の .env に在る。
    const env = await readFile(join(home, '.env'), 'utf8');
    assert.match(env, /ghp_ひみつ/);
  });

  test('合言葉を渡さなければ、何が要るかを言う（黙って繋いだ顔をしない）', async () => {
    const { connect } = await inBox();
    delete process.env.GITHUB_TOKEN;
    const got = await connect.connectService('github');
    assert.equal(got.ok, true);
    assert.deepEqual(got.missing.map((m) => m.env), ['GITHUB_TOKEN']);
  });

  test('廃止されているものは、繋いでもそう言う', async () => {
    const { connect } = await inBox();
    const got = await connect.connectService('github-local', { secrets: { GITHUB_TOKEN: 'x' } });
    assert.equal(got.ok, true);
    assert.ok(got.notes.some((n) => n.includes('archived')), got.notes.join(' / '));
  });

  test('知らない名前は、在るものを並べて断る', async () => {
    const { connect } = await inBox();
    const got = await connect.connectService('そんなものはない');
    assert.equal(got.ok, false);
    assert.match(got.error ?? '', /github/);
  });

  test('外すと、設定から消える', async () => {
    const { home, connect } = await inBox();
    await connect.connectService('memory');
    assert.match(await readFile(join(home, 'aas.config.json'), 'utf8'), /memory/);
    const got = await connect.disconnectService('memory');
    assert.equal(got.ok, true);
    const after = JSON.parse(await readFile(join(home, 'aas.config.json'), 'utf8')) as
      { mcp?: { servers?: Record<string, unknown> } };
    assert.equal(after.mcp?.servers?.memory, undefined);
  });
});
