/**
 * 合議の検証。
 * 気質の違う担当が同じ対象を見て、違うものを拾えることを確かめる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator } from '../src/core/orchestrator.ts';
import { runPanel, mergeFindings, type PanelEvent, type PanelFinding } from '../src/agent/panel.ts';
import { RoleRegistry } from '../src/roles/registry.ts';
import { readFileTool, searchTextTool, writeFileTool } from '../src/agent/tools/fs.ts';
import { createRunCommandTool } from '../src/agent/tools/shell.ts';

/** 役職ごとに違う所見を返す偽モデル。システムプロンプトで役職を見分ける。 */
async function roleAwareServer(answers: Record<string, string>) {
  const seenRoles: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"m"}]}');
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const system = parsed.messages.find((m) => m.role === 'system')?.content ?? '';
      const roleId = Object.keys(answers).find((id) => system.includes(id)) ?? 'unknown';
      if (!seenRoles.includes(roleId)) seenRoles.push(roleId);

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = answers[roleId] ?? '問題なし';
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seenRoles,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const proposal = (title: string, action = 'やること') =>
  `PROPOSAL\ntitle: ${title}\nrationale: 確認した結果\naction: ${action}`;

async function panel(answers: Record<string, string>, roleIds: string[]) {
  const server = await roleAwareServer(answers);
  const root = await mkdtemp(join(tmpdir(), 'aas-panel-'));
  await writeFile(join(root, 'a.ts'), 'export const f = (x) => x.trim();');
  try {
    const registry = new ProviderRegistry();
    registry.register(new OpenAiCompatibleProvider({ id: 'local', baseUrl: server.baseUrl, locality: 'local' }));
    const roles = new RoleRegistry();

    const events: PanelEvent[] = [];
    const gen = runPanel(
      new ChatOrchestrator(registry),
      'a.ts を見てください',
      {
        roles: roleIds.map((id) => roles.get(id)!),
        candidates: ['local:m'],
        root,
        toolPool: {
          read: [readFileTool, searchTextTool],
          write: [writeFileTool],
          execute: [createRunCommandTool({ allowed: ['node'] })],
        },
        parallel: 3,
      },
      new AbortController().signal,
    );
    let next = await gen.next();
    while (!next.done) { events.push(next.value); next = await gen.next(); }
    return { events, findings: next.value as PanelFinding[], seenRoles: server.seenRoles };
  } finally {
    await server.close();
  }
}

describe('合議', () => {
  test('気質の違う担当が、それぞれ違うものを拾う', async () => {
    const { findings } = await panel({
      '検査担当': '問題なし',
      '破壊担当': proposal('空文字を渡すと trim で落ちる'),
      '安全担当': proposal('外部入力がそのまま渡っている'),
    }, ['tester', 'breaker', 'security']);

    const titles = findings.map((f) => f.title);
    assert.equal(findings.length, 2, `拾えた数が想定と違う: ${titles.join(' / ')}`);
    assert.ok(titles.some((t) => t.includes('空文字')), '破壊担当の指摘が落ちている');
    assert.ok(titles.some((t) => t.includes('外部入力')), '安全担当の指摘が落ちている');
  });

  test('真面目な検査だけでは拾えないものを、破壊担当が拾う', async () => {
    const straight = await panel({ '検査担当': '問題なし' }, ['tester']);
    assert.equal(straight.findings.length, 0);

    const withBreaker = await panel({
      '検査担当': '問題なし',
      '破壊担当': proposal('境界値で落ちる'),
    }, ['tester', 'breaker']);
    assert.equal(withBreaker.findings.length, 1, '人を増やした意味が出ていない');
  });

  test('問題なしと答えた担当も記録される', async () => {
    const { events } = await panel({ '検査担当': '問題なし' }, ['tester']);
    assert.ok(events.some((e) => e.type === 'noFinding' && e.roleId === 'tester'));
  });

  test('一人が失敗しても他は続く', async () => {
    const { findings, events } = await panel({
      '検査担当': proposal('見つけた'),
      // 破壊担当には答えを用意しない → 問題なし扱い
    }, ['tester', 'breaker']);
    assert.equal(findings.length, 1);
    assert.ok(events.some((e) => e.type === 'assigned' && e.roleId === 'breaker'));
  });

  test('担当ごとに違うシステムプロンプトが渡る', async () => {
    const { seenRoles } = await panel({
      '検査担当': '問題なし', '破壊担当': '問題なし', '安全担当': '問題なし',
    }, ['tester', 'breaker', 'security']);
    assert.equal(seenRoles.length, 3, `役職が区別されていない: ${seenRoles.join(',')}`);
  });
});

describe('所見のまとめ', () => {
  const f = (roleName: string, title: string): PanelFinding => ({
    roleId: 'x', roleName, title, rationale: '理由', action: 'やること',
  });

  test('複数の担当が同じ指摘をしたらまとめる', () => {
    const merged = mergeFindings([
      f('破壊担当', '空文字で落ちる'),
      f('安全担当', '空文字で落ちる。'),
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]!.alsoBy, ['安全担当']);
  });

  test('違う指摘は分けたまま残す', () => {
    const merged = mergeFindings([
      f('破壊担当', '空文字で落ちる'),
      f('安全担当', '入力が検査されていない'),
    ]);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0]!.alsoBy, []);
  });
});
