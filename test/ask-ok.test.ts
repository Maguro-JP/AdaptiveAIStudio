/**
 * 画面は、本体に断られたのに効いた顔をしない。
 *
 * `ask` は繋がらなかったときだけ `undefined` を返し、断られた（400・404・409・500）ときは中身を返す。`if (!r) return;` だけで先へ
 * 進むと、断られたのに「外しました」「やめました」と言う。やり残しの「×」（500 で黙る）と MCP の「外す」（外せなくても
 * 「外しました」）で同じ形を二度作り、提案の採否（送る前に「着手します」と言い、返事を捨てる）は二か所に同じ形があった。
 * 注意書きでは防げなかったので、ここで止める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const web = join(import.meta.dirname, '..', 'src', 'ui', 'web');

/** 注釈の行を除いた行（`//` と `*` で始まる行）。注釈の中の `r.ok` で通らないように。 */
async function codeLines(): Promise<{ name: string; lines: string[] }[]> {
  const out: { name: string; lines: string[] }[] = [];
  for (const name of (await readdir(web)).filter((n) => n.endsWith('.js'))) {
    const lines = (await readFile(join(web, name), 'utf8')).split('\n')
      .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l));
    out.push({ name, lines });
  }
  return out;
}

test('**`ask` の返事を受け取ったら、次に `ask` を呼ぶまでに（最大 25 行）その `ok` を見る**', async () => {
  const bad: string[] = [];
  let seen = 0;
  for (const { name, lines } of await codeLines()) {
    lines.forEach((line, i) => {
      const m = /(\w+)\s*=\s*await\s+ask\(/.exec(line);
      if (!m) return;
      seen += 1;
      const window: string[] = [line];
      for (let j = i + 1; j < Math.min(lines.length, i + 25); j += 1) {
        if (/await\s+ask\(/.test(lines[j]!)) break;
        window.push(lines[j]!);
      }
      if (!new RegExp(`\\b${m[1]}\\??\\.ok\\b`).test(window.join('\n'))) bad.push(`${name}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.ok(seen >= 10, `ask を呼ぶ所を見つけられていない（${seen} 件）。書き方が変わったなら、この試験も合わせる`);
  assert.deepEqual(bad, [], `断られたときを見ていない:\n${bad.join('\n')}`);
});

/**
 * 書き込み（`method:` を持つ）の生の `fetch(` は、受け取ってその `ok` を見る。投げっぱなしにしてよい所は置かない
 * （中断と添付を外すのも、失敗したら言う。止めたつもりで回り続ける・消したつもりで写しが残る、を作らない）。
 * `ask` / `askJson` / `tell` の中身は、そこで見ている。
 */

test('**書き込みの `fetch` は、返事の `ok` を見る**（投げっぱなしにしない）', async () => {
  const bad: string[] = [];
  let seen = 0;
  for (const { name, lines } of await codeLines()) {
    lines.forEach((line, i) => {
      if (!/\bfetch\(/.test(line)) return;
      const call = lines.slice(i, i + 4).join('\n');
      if (!/method:\s*['"`]?(POST|PUT|DELETE|PATCH)|method:\s*\w/.test(call)) return; // 読むだけのものは見ない
      seen += 1;
      // 助け手の中身（ask・askJson・tell）は、それ自身が ok を見ている
      const above = lines.slice(Math.max(0, i - 6), i).join('\n');
      if (/(async function (ask|askJson|tell)\b)/.test(above)) return;
      // `.then((r) => ({ ok: r.ok, … }))` のように、その場で ok を持ち出す形はよい
      if (/\.then\(async \((\w+)\) => \(\{ ok: \1\.ok/.test(call)) return;
      const m = /(\w+)\s*=\s*await\s+fetch\(/.exec(line);
      // 保存のように、行き違い（409）を先に分けてから ok を見る所があるので、見る行は広めに取る
      const after = lines.slice(i, i + 60).join('\n');
      if (!m || !new RegExp(`\\b${m[1]}\\??\\.ok\\b`).test(after)) bad.push(`${name}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.ok(seen >= 10, `書き込みの fetch を見つけられていない（${seen} 件）。書き方が変わったなら、この試験も合わせる`);
  assert.deepEqual(bad, [], `返事の ok を見ていない書き込み:\n${bad.join('\n')}`);
});

/**
 * 中断（`/api/abort`）は、繋がらないとき・断られたときに黙らない。黙ると、止めたつもりで止まっていない
 * （受け手の無い失敗は「途中で止まりました」とだけ出る）。
 */
test('**中断を送る所は、繋がらないときに黙らない受け手を持つ**', async () => {
  const bad: string[] = [];
  let seen = 0;
  for (const { name, lines } of await codeLines()) {
    const src = lines.join('\n');
    // 引用符の違い・助け手（ask）を通した書き方も数える
    for (const m of src.matchAll(/(?:fetch|ask)\(\s*['"`]\/api\/abort/g)) {
      seen += 1;
      const at = m.index ?? 0;
      const end = src.indexOf(';', at);
      const stmt = src.slice(at, end < 0 ? at + 300 : end);
      // 受けて何も言わない形（`.catch((e) => undefined)`）は通さない。画面に出す（showCrash・note）ところまで見る。
      // try で包む形は、続く catch が画面に出すこと（繋がらない）と、ok を見て出すこと（断られた）の両方を見る
      const after = src.slice(at, at + 600);
      const caught = /\.catch\(\(e\) =>[^;]*\b(showCrash|note)\(/.test(stmt)
        || (/!r\.ok\)[\s\S]*?\b(showCrash|note)\(/.test(after) && /\} catch \(e\) \{\s*\b(showCrash|note)\(/.test(after));
      if (!caught && !/^ask\(/.test(stmt)) bad.push(`${name}:${src.slice(0, at).split('\n').length}`);
    }
  }
  assert.ok(seen >= 2, `中断を送る所を見つけられていない（${seen} 件）`);
  assert.deepEqual(bad, [], `繋がらないときに黙る中断:\n${bad.join('\n')}`);
});
