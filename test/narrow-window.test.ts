/**
 * 狭い窓で、道具がまだ呼べる。
 *
 * 窓の取り分を直したとき、道具の説明を**段を追って削る**形にした。
 * 削り方を変えたのに、削った後で本当に呼べるかは見ていなかった。
 * **削れば入る。入っても呼べなければ意味がない。**
 *
 * 本物のモデル（乱数の重み）は道具を呼ばないので、そこでは確かめられない。
 * 作り物の相手に「この道具を呼ぶ」と言わせて、端まで通す。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { Session } from '../src/core/session.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

let fake: FakeServer;
let root = '';

before(async () => {
  root = await tempDir('aas-narrow-');
  await writeFile(join(root, 'a.txt'), 'ここが中身です\n');
  fake = await startFakeServer({ kind: 'stream', text: 'はい' });
});
after(async () => { await fake.close(); });

function config(window: number) {
  return {
    ...DEFAULT_CONFIG,
    providers: [{
      id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl,
      locality: 'local', models: ['m'],
    }],
    candidates: ['local:m'],
    runtime: { contextSize: window },
    agent: { root, approval: 'auto', maxTurns: 3, verify: { enabled: false } },
    initiative: { enabled: false },
  } as never;
}

/** 送られた依頼のうち、道具の一覧を取り出す。 */
function toolsSent(bodies: unknown[]): Array<{ function?: { name?: string; description?: string; parameters?: unknown } }> {
  for (let i = bodies.length - 1; i >= 0; i -= 1) {
    const b = bodies[i] as { tools?: unknown[] };
    if (Array.isArray(b?.tools) && b.tools.length > 0) return b.tools as never;
  }
  return [];
}

describe('狭い窓でも、道具は呼べる', () => {
  for (const window of [4096, 32768]) {
    test(`窓 ${window} で、道具の呼び出しが通る`, async () => {
      fake.setBehavior({
        kind: 'toolcall', name: 'read_file', args: { path: 'a.txt' }, then: '読みました。',
      });
      const session = await Session.create(config(window), { approve: () => Promise.resolve(true) });
      const seen: string[] = [];
      for await (const ev of session.send('a.txt を読んで')) {
        if (ev.type === 'toolStart') seen.push(ev.name);
      }
      assert.ok(seen.includes('read_file'), `道具が呼ばれていない: ${seen.join(',')}`);

      // 削っても、**名前と引数の形は残っている**。ここが崩れると呼べない。
      const tools = toolsSent(fake.bodies);
      assert.ok(tools.length > 0, '道具を渡していない');
      const read = tools.find((t) => t.function?.name === 'read_file');
      assert.ok(read, `read_file を渡していない: ${tools.map((t) => t.function?.name).join(',')}`);
      const params = read.function?.parameters as { properties?: Record<string, unknown> };
      assert.ok(params?.properties?.path, '引数の形が落ちている');
    });
  }

  test('狭い窓では説明が短くなる。広い窓では短くしない（対）', async () => {
    const lengthAt = async (window: number): Promise<number> => {
      fake.bodies.length = 0;
      fake.setBehavior({ kind: 'stream', text: 'はい' });
      const session = await Session.create(config(window), { approve: () => Promise.resolve(true) });
      // **作業の依頼で測る。**「こんにちは」は問いかけとして扱われ、
      // ツールを載せない（`looksLikeChat`）ので、長さが 0 と 0 の比べになる。
      for await (const _ of session.send('a.txt を読んで直して')) { /* 流し切る */ }
      return toolsSent(fake.bodies)
        .reduce((n, t) => n + (t.function?.description ?? '').length, 0);
    };
    const narrow = await lengthAt(4096);
    const wide = await lengthAt(32768);
    assert.ok(wide > 0, '広い窓で説明が消えている');
    assert.ok(narrow < wide, `狭い窓で削れていない: ${narrow} / ${wide}`);
  });
});
