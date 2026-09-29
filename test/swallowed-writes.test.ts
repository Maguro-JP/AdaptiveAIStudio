/**
 * 書く・消す・移すの失敗を黙って捨てる書き方を、新しく持ち込ませない。
 *
 * 2026-09-29 に、戻し終えた戻り先を消せない・書き直せないのを黙って捨て、一覧に残った戻り先をもう一度押すと、その後の直しを
 * 古い姿で上書きする形を直した（#122）。書き込みの失敗を捨ててよいのは、後に何も残らないか、残っても次に困らない所だけ。
 *
 * ここでは、writeFile・appendFile・rename・rm・unlink・mkdir・copyFile・rmdir・writeStored の失敗を空の値で受ける
 * `.catch(() => …)` と `.then(() => …, () => …)` をファイルごとに数える。下の一覧に「なぜ捨ててよいか」を書くまで落とす。
 * 数が増えても落とす。直して減ったのに一覧が古いままのときも落とす。
 *
 * 数えるのは一行に収まる形だけ（`try { … } catch { }` は数えない）。読みの側は `test/lenient-reads.test.ts`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const root = join(import.meta.dirname, '..');

/** 失敗を捨ててよいファイルと、その数・理由。 */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'src/core/undo.ts': { count: 3, why: '一時ファイルの後始末、古い戻り先の片づけ（残るだけ）、縮めた戻り先の書き直し（失敗は unshrunk で言う）' },
  'src/core/conversations.ts': { count: 2, why: '一時ファイルの後始末と、立ち上げたときの捨て場の片づけ（消せたものだけ数え、残りは次にまた消す）' },
  'src/runtime/machine.ts': { count: 2, why: '機械の検出結果の記録。書けなければ次に検出し直すだけ' },
  'src/runtime/llama-install.ts': { count: 1, why: '取り出しに失敗したときの後始末。元の失敗を投げ直す' },
  'src/ui/server.ts': { count: 1, why: '作業場のフォルダを作っておくだけ。作れなければ一覧を読む所が言う' },
  'src/harness/metrics.ts': { count: 1, why: '書く前の mkdir。作れなければ続く書き込みが落ちる' },
  'src/agent/proposals.ts': { count: 1, why: '一時ファイルの後始末' },
  'src/roles/ledger.ts': { count: 1, why: '書く前の mkdir。作れなければ続く書き込みが落ちる' },
  'src/core/goals.ts': { count: 1, why: '一時ファイルの後始末' },
  'src/core/session.ts': { count: 1, why: '作業場のフォルダを作っておくだけ。作れなければ使う所が言う' },
  'src/core/unfinished.ts': { count: 1, why: '一時ファイルの後始末' },
  'src/core/journal-file.ts': { count: 1, why: '一時ファイルの後始末' },
  'src/core/logfile.ts': { count: 1, why: '記録の回し。回せなければ同じファイルに書き続ける' },
  'src/memory/memory.ts': { count: 1, why: '一時ファイルの後始末' },
};

const SWALLOWED = /\b(writeFile|appendFile|rename|rm|unlink|mkdir|copyFile|rmdir|writeStored)\([^;]*?\)[^;]*?(\.catch\(|\.then\(\([^()]*\) => [^(),;]*, )\(\) => (undefined|\{[^}]*\}|false|null|0|true)\)/g;

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...await sources(path));
    else if (/\.(ts|js|mjs)$/.test(e.name)) out.push(path);
  }
  return out;
}

/** 注釈の行を除いた中身。注釈に書いた例で数えない。 */
function codeOnly(text: string): string {
  return text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

test('書く・消す・移すの失敗を黙って捨てる書き方は、一覧に理由を書いたファイルに、書いた数だけ', async () => {
  const problems: string[] = [];
  for (const abs of await sources(join(root, 'src'))) {
    const rel = relative(root, abs).split(sep).join('/');
    const n = codeOnly(await readFile(abs, 'utf8')).match(SWALLOWED)?.length ?? 0;
    if (n === 0) continue;
    const allowed = ALLOWED[rel];
    if (!allowed) {
      problems.push(`${rel}: ${n} か所。失敗を言う側へ回すか、後に何も残らない・残っても困らないと確かめて一覧に理由を書く`);
    } else if (n > allowed.count) {
      problems.push(`${rel}: ${allowed.count} か所のはずが ${n} か所。増えた所を見直す`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('一覧に、もう無いファイル・減った数を残さない（直した所を一覧が隠さないように）', async () => {
  const stale: string[] = [];
  for (const [rel, { count }] of Object.entries(ALLOWED)) {
    const text = await readFile(join(root, rel), 'utf8').catch(() => undefined);
    const n = text === undefined ? 0 : codeOnly(text).match(SWALLOWED)?.length ?? 0;
    if (n < count) stale.push(`${rel}: 一覧は ${count} か所、いまは ${n} か所`);
  }
  assert.deepEqual(stale, [], stale.join('\n'));
});
