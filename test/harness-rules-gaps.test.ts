/**
 * ハーネスの規則と見回りの不具合（41 回目の調査）。
 *
 * - 失敗した write_file を「前に書いた」と数えない（待つ間に誰かが作ったファイルを、読まずに全文で上書きさせない）
 * - 断られた・失敗した書き込みを、書き換えた件数に数えない
 * - 持ち出しのチェックが、AWS の資格情報の書き方・GitHub の他のトークン・暗号化した秘密鍵を止める
 * - 守りの一覧の `secrets/`・`/config/**` が、黙って何も守らない形にならない
 * - 時計が戻っても、考えごとと日課が止まり続けない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Harness } from '../src/harness/harness.ts';
import { readBeforeWrite, blastRadius, protectedPaths, protectedPattern } from '../src/harness/builtin-rules.ts';
import { inspectOutbound } from '../src/harness/gate.ts';
import { IdleScheduler } from '../src/harness/idle.ts';
import { BUILTIN_IDLE_MODES } from '../src/harness/idle-modes.ts';
import { writeFileTool } from '../src/agent/tools/fs.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

function ctx(root: string, approve: ToolContext['approve'] = async () => true): ToolContext {
  return { root, signal: new AbortController().signal, approve };
}

describe('読んでから書く', () => {
  test('**失敗した write_file を「前に書いた」と数えず、その後に作られたファイルを読まずに上書きさせない**', async () => {
    const root = await tempDir('aas-hrg-rbw-');
    const h = new Harness({ rules: [readBeforeWrite] });
    const write = h.wrap(writeFileTool, () => '');
    // 承認を待つ間に、別の誰かが同じ名前で作る
    const first = await write.run({ path: 'x.txt', content: 'mine\n' }, ctx(root, async () => {
      await writeFile(join(root, 'x.txt'), 'someone else\n');
      return true;
    }));
    assert.equal(first.isError, true, `前提: 一度目は失敗する: ${first.content}`);
    const again = await write.run({ path: 'x.txt', content: 'mine\n' }, ctx(root));
    assert.equal(again.isError, true, '読んでいないファイルを全文で上書きさせた');
    assert.equal(await readFile(join(root, 'x.txt'), 'utf8'), 'someone else\n');
  });
});

describe('書き換えた件数', () => {
  test('**断られた書き込みを、書き換えた件数に数えない**', async () => {
    const root = await tempDir('aas-hrg-blast-');
    const h = new Harness({ rules: [blastRadius(1)] });
    const write = h.wrap(writeFileTool, () => '');
    const declined = await write.run({ path: 'a.txt', content: 'a\n' }, ctx(root, async () => false));
    assert.equal(declined.isError, true, '前提: 断られる');
    const next = await write.run({ path: 'b.txt', content: 'b\n' }, ctx(root));
    assert.notEqual(next.isError, true, `断った分を数えて止めた: ${next.content}`);
  });
});

describe('持ち出しのチェック', () => {
  for (const [what, text] of [
    ['~/.aws/credentials の書き方', '[default]\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n'],
    ['export の付いた書き方', 'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG\n'],
    ['JSON の書き方', '{\n  "AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENGbPxRfiCY",\n}\n'],
    ['GitHub の ghs_ トークン', `token: ghs_${'a'.repeat(36)}\n`],
    ['GitHub の ghu_ トークン', `ghu_${'B'.repeat(36)}`],
    ['暗号化した秘密鍵', '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIE...\n'],
  ] as const) {
    test(`**${what}を外へ出さない**`, () => {
      assert.equal(inspectOutbound(text).passed, false, text);
    });
  }

  for (const [what, text] of [
    ['環境から読むコード', 'github_token = os.environ["GITHUB_TOKEN"]\n'],
    ['CI の設定', 'env:\n  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n'],
    ['鍵の名前だけを書いた文', 'aws_secret_access_key を設定してください\n'],
  ] as const) {
    test(`${what}は止めない`, () => {
      assert.equal(inspectOutbound(text).passed, true, text);
    });
  }
});

describe('守りの一覧の書き方', () => {
  test('**末尾の / はフォルダの中身全部、頭の / は作業場の根として読む**', () => {
    assert.equal(protectedPattern('secrets/'), 'secrets/**');
    assert.equal(protectedPattern('/config/**'), 'config/**');
    assert.equal(protectedPattern('./keys/*.pem'), 'keys/*.pem');
    assert.equal(protectedPattern('.env'), '.env');
  });

  test('**secrets/ と書いたら、その中へ書かせない**', async () => {
    const root = await tempDir('aas-hrg-protect-');
    const h = new Harness({ rules: [protectedPaths(['secrets/', '/config/**'])] });
    const write = h.wrap(writeFileTool, () => '');
    for (const p of ['secrets/key.txt', 'config/app.json']) {
      const r = await write.run({ path: p, content: 'x\n' }, ctx(root));
      assert.equal(r.isError, true, `${p} に書かせた: ${r.content}`);
    }
  });
});

describe('時計が戻ったとき', () => {
  test('**前の時刻が「今」より先に残っても、考えごとを止め続けない**', async () => {
    const s = new IdleScheduler(BUILTIN_IDLE_MODES, { perHour: 12, minGapMs: 600_000, maxPerChange: 2 });
    const ahead = Date.UTC(2026, 9, 6, 12);
    const mode = BUILTIN_IDLE_MODES[0]!;
    s.begin(mode, ahead);
    // 時計が 5 時間戻り、そこから 20 分たった
    const now = ahead - 5 * 3_600_000 + 20 * 60_000;
    const d = await s.choose({ lastChangeAt: now - 60_000, openProposals: 0, now });
    assert.doesNotMatch(d.reason, /あと約\s*[0-9]{3,}/, `何時間も待たせる: ${d.reason}`);
  });
});
