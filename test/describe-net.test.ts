/**
 * 網の失敗を、人の言葉で言う。
 *
 * Node の fetch は本当の理由を `cause` に隠して `fetch failed` だけを投げる。
 * 上の文だけを見ていたので、会社の回線で出るのは `fetch failed` の一語だった。
 * 証明書で断られたのか、名前が引けないのかで打つ手はまるで違う。
 *
 * しかも、いちばん最初に当たる呼び出し（配布元の一覧）はこの関数を通って
 * すらいなかった。書いたのに、誰も読まない所に置いてあった。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeNet } from '../src/runtime/net-why.ts';

// **走らせる場所で結果が変わらないようにする。**相対の道で読んでいたので、
// 別の場所から走らせると「そんなファイルは無い」で落ちた（実際に落とした）。
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 本物の fetch の失敗。繋ぐ先が居ない口へ出して作る。 */
async function realFailure(url: string): Promise<unknown> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return undefined;
  } catch (e) { return e; }
}

test('cause の中の理由まで見る', () => {
  const wrap = (code: string, msg = 'fetch failed') => {
    const outer = new Error(msg);
    (outer as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
    return outer;
  };
  assert.match(describeNet(wrap('ENOTFOUND')), /名前を引けません/);
  assert.match(describeNet(wrap('ECONNREFUSED')), /断られました/);
  assert.match(describeNet(wrap('CERT_HAS_EXPIRED')), /証明書/);
  assert.match(describeNet(wrap('ETIMEDOUT')), /時間切れ/);
});

test('本物の失敗でも、fetch failed のままにしない', async () => {
  // 127.0.0.1 の、誰も待っていない口。拒否が返るので速い。
  const e = await realFailure('http://127.0.0.1:1/');
  assert.ok(e !== undefined, 'この確かめの前提が崩れている（繋がってしまった）');
  const said = describeNet(e);
  assert.notEqual(said, 'fetch failed', `そのままです: ${said}`);
});

test('外へ出て失敗した所は、どれもこの関数を通る', async () => {
  /*
   * 会社の回線で最初に落ちるのは配布元の一覧を引くところ。そこだけが
   * 生の文をそのまま出していた（`fetch failed`）。直したあとで数えたら、
   * 同じ形が llama-server・Ollama・新しい版の確認にも残っていた。
   * **一つ直して終わりにしない。**
   */
  const { readFile } = await import('node:fs/promises');
  const files = [
    'src/runtime/model-install.ts', 'src/runtime/llama-install.ts',
    'src/runtime/ollama-pull.ts', 'src/runtime/model-updates.ts',
  ];
  const bad: string[] = [];
  for (const f of files) {
    const src = await readFile(join(root, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      // 網の失敗を人へ見せている行に、生の文がそのまま入っていないか。
      if (!/繋がりません|取ってこられませんでした|訊けませんでした|一覧に/.test(line)) return;
      if (!/e instanceof Error \? e\.message/.test(line)) return;
      bad.push(`${f}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, [], `生の文をそのまま出しています:\n  ${bad.join('\n  ')}`);
});

test('分からないものは、分かったふりをしない', () => {
  assert.equal(describeNet(new Error('なにか別のもの')), 'なにか別のもの');
});
