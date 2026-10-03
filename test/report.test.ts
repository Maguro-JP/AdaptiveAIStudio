/**
 * 困ったときの報告は、押したら一つのファイルになる。
 * 要るものが揃い、トークンの値は出ず、テストの結果と記録の末尾が入る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';

const home = await tempDir('aas-report-');
process.env.AAS_HOME = home;
process.env.AAS_STATE_DIR = join(home, 'state');
process.env.AAS_CONFIG = join(home, 'aas.config.json');
const { buildReport, redactSecrets } = await import('../src/cli/report.ts');
/** 進み具合の行を標準出力へ書かせない（試験の受け口がそこを記録の道として読み、割り込んだ行で壊れた）。 */
const quiet = (): void => {};
const { saveReport } = await import('../src/cli/report-file.ts');

describe('困ったときの報告', () => {
  test('トークンの値を伏せる。名前は残す', () => {
    const out = redactSecrets('{"apiKey":"sk-123","envFrom":{"GITHUB_TOKEN":"MY_TOKEN"},"password":"p","name":"ok"}');
    assert.ok(!out.includes('sk-123') && !out.includes('"p"'), out);
    assert.ok(out.includes('"apiKey"') && out.includes('"name":"ok"'), out);
    // envFrom の値は環境変数の名前。値ではないが、名前に TOKEN を含むので伏せる側に倒す（安全側）。
    assert.ok(!out.includes('MY_TOKEN'), out);
  });

  /**
   * **項目の名前が無いまま、値だけが出ることがある。**
   *
   * 設定は名前しか書かない作りだが、記録（`ui.log`）や点検の出力には、見出しを
   * 丸ごと出した行や、外のツールのエラーがそのまま残る。名前だけで判じていると
   * そこがすり抜ける。報告は外へ出すものなので、値の形でも伏せる。
   */
  test('**値の形でも伏せる（名前が無くても）**', () => {
    const out = redactSecrets([
      'GET /mcp/ Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'github へ: ghp_abcdefghijklmnopqrstuvwxyz0123',
      'openai へ: sk-proj-abcdefghijklmnopqrstuv',
      'slack: xoxb-1234567890-abcdefghij',
      '普通の行はそのまま（Bearer は付いていない）',
    ].join('\n'));
    assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz'), `Bearer の後ろが出ている: ${out}`);
    assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), out);
    assert.ok(!out.includes('sk-proj-abcdefghijklmnopqrstuv'), out);
    assert.ok(!out.includes('xoxb-1234567890-abcdefghij'), out);
    assert.ok(out.includes('普通の行はそのまま'), out);
  });

  test('**検問所が秘密として知っている形（fine-grained・AWS・HF）と、.env・引数の形も伏せる**', () => {
    const lines = [
      'x github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'aws AKIAABCDEFGHIJKLMNOP',
      'hf hf_abcdefghijklmnopqrstuvwxyz012345',
      'ANTHROPIC_API_KEY=plainvalue123',
      'args: ["--token", "argvalue456"]',
      'cmd --api-key=flagvalue789',
      'PATH=/usr/bin のような名前でない行はそのまま',
      'GITHUB_TOKEN="quotedvalue111"',
      "DB_PASSWORD='quotedvalue222'",
      'cmd --token="quotedvalue333"',
      'the max-token count and a non-secret value stay',
    ];
    const out = redactSecrets(lines.join('\n'));
    for (const leaked of ['github_pat_11ABCDEFG', 'AKIAABCDEFGHIJKLMNOP', 'hf_abcdefghijklmnop', 'plainvalue123', 'argvalue456', 'flagvalue789',
      'quotedvalue111', 'quotedvalue222', 'quotedvalue333']) {
      assert.ok(!out.includes(leaked), `${leaked} が出ている:\n${out}`);
    }
    assert.ok(out.includes('PATH=/usr/bin'), out);
    // 普通の言葉の一部（max-token・non-secret）は巻き込まない
    assert.ok(out.includes('the max-token count and a non-secret value stay'), `普通の文を伏せている:\n${out}`);
    assert.ok(out.includes('ANTHROPIC_API_KEY=') && out.includes('--token'), `名前まで消している:\n${out}`);
  });

  test('**記録の節も伏せてから出す**', async () => {
    const state = join(home, 'redact-state');
    await mkdir(join(state, 'logs'), { recursive: true });
    await writeFile(join(state, 'logs', 'ui.log'), 'つながりませんでした: Authorization: Bearer ghp_zzzzzzzzzzzzzzzzzzzz\n');
    /*
     * doctor は渡す（他の試験と同じ）。渡さないと、根を一時のフォルダにしたまま本物の doctor を
     * 子で起こし、`MODULE_NOT_FOUND` の出力がそのまま試験の標準出力へ流れる。node の試験の
     * 受け口はそこを記録の道として読むので、割り込んだ出力で一度だけ壊れた
     * （`Unable to deserialize cloned data`、2026-09-24 の check:bundle）。
     */
    const text = await buildReport({ say: quiet,
      root: home, state, models: join(home, 'models'), home,
      doctor: async () => 'DOCTOR-OUT',
    } as never);
    assert.ok(!text.includes('ghp_zzzzzzzzzzzzzzzzzzzz'), '記録に出たトークンが、そのまま報告へ出ている');
  });

  test('版・機械・設定・モデル・doctor・記録・点検が一つに揃う', async () => {
    const state = join(home, 'state');
    const models = join(home, 'models');
    await mkdir(join(state, 'logs'), { recursive: true });
    await mkdir(join(state, 'reports'), { recursive: true });
    await mkdir(models, { recursive: true });
    await writeFile(join(home, 'aas.config.json'), '{"runtime":{"kind":"inproc"},"secretToken":"HIDE-ME"}');
    await writeFile(join(state, 'machine.json'), '{"gpuName":null,"ramBytes":1}');
    await writeFile(join(state, 'logs', 'ui.log'), Array.from({ length: 500 }, (_, i) => `2026-09-11 00:00:00 [info] line ${i}`).join('\n') + '\n');
    await writeFile(join(state, 'audit.jsonl'), '{"a":1}\n{"a":2}\n');
    await writeFile(join(state, 'reports', 'test-20260911-0100.txt'), 'not ok 1 - 古い\n');
    await writeFile(join(state, 'reports', 'test-20260911-0200.txt'), 'not ok 9 - 新しい\n');
    await writeFile(join(models, 'a.gguf'), 'GGUF');
    const body = await buildReport({ say: quiet, root: process.cwd(), state, home, models, doctor: async () => 'DOCTOR-OUT 動かせます' });
    for (const must of ['## 版', 'Node: v', '## 機械', '"gpuName"', '## 設定', '"secretToken"', '## モデル', 'a.gguf', '## doctor', 'DOCTOR-OUT', '## 直近の記録', 'line 499', '## 直近の操作', '{"a":2}', '直近の点検: test', 'not ok 9 - 新しい']) {
      assert.ok(body.includes(must), `無い: ${must}`);
    }
    assert.ok(!body.includes('HIDE-ME'), 'トークンの値が出ている');
    assert.ok(!body.includes('line 0\n'), '記録の頭まで全部入れている（末尾だけでよい）');
    assert.ok(!body.includes('古い'), '古い点検の結果を入れている');
  });

  test('直近の doctor が新しければ、使い回す（毎回 1〜2 分回さない）', async () => {
    const dir = await tempDir('aas-report-reuse-');
    const reports = join(dir, 'reports');
    await mkdir(reports, { recursive: true });
    await writeFile(join(reports, 'doctor-20260912-1200.txt'), 'CACHED-DOCTOR よい状態です\n');
    let ran = false;
    const body = await buildReport({ say: quiet,
      root: dir, state: dir, home, models: join(dir, 'models'),
      doctor: async () => { ran = true; return 'FRESH-RUN'; },
    });
    assert.equal(ran, false, '新しい doctor があるのに回している');
    assert.ok(body.includes('CACHED-DOCTOR'), '使い回した中身が入っていない');
    assert.ok(body.includes('使い回しました'), '使い回したと言っていない');
    assert.ok(!body.includes('FRESH-RUN'), '使い回すはずが回している');
  });

  test('直近の doctor が古ければ、その場で回す（対）', async () => {
    const dir = await tempDir('aas-report-stale-');
    const reports = join(dir, 'reports');
    await mkdir(reports, { recursive: true });
    await writeFile(join(reports, 'doctor-20260912-1200.txt'), 'CACHED-DOCTOR\n');
    let ran = false;
    const body = await buildReport({ say: quiet,
      root: dir, state: dir, home, models: join(dir, 'models'),
      doctorMaxAgeMs: 0, // どんな控えも「古い」扱いにする
      doctor: async () => { ran = true; return 'FRESH-RUN その場で回した'; },
    });
    assert.equal(ran, true, '古い doctor しかないのに回していない');
    assert.ok(body.includes('FRESH-RUN'), '回した結果が入っていない');
    assert.ok(body.includes('その場で doctor を回しました'), '回したと言っていない');
  });

  test('置く先を AAS_REPORT_DIR で変えられる（テストがプログラムの隣に撒かないため）', async () => {
    const dir = await tempDir('aas-report-dir-');
    const prev = process.env.AAS_REPORT_DIR;
    process.env.AAS_REPORT_DIR = dir;
    try {
      const saved = await saveReport('report', 'x', ['/proc/aas-cannot']);
      assert.ok(saved.path?.startsWith(dir), JSON.stringify(saved));
      assert.equal(await readFile(saved.path!, 'utf8'), 'x');
    } finally {
      if (prev === undefined) delete process.env.AAS_REPORT_DIR; else process.env.AAS_REPORT_DIR = prev;
    }
  });
});
