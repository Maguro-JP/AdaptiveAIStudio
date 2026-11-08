/**
 * 画面と確かめ（check-work）が読む「本体が動いているか」（`/api/approvals` の busy）。
 *
 * Windows の check-work（2026-11-08、Qwen3.5-4B）で、作業場を変えた直後の最初の質問が、送って 5 秒で「答えが空です」になった。
 * 本体（Session）を畳んだ直後で、モデルを読んでいる間は本体がまだ無い。busy は本体があるときだけ見ていたので、
 * 支度の最中に「空いている」と返し、答えの出る 1 分前に読みに行っていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-screen-busy-');
const { screenBusy } = await import('../src/ui/server.ts');

test('本体がまだ無くても、支度（読み込み・組み立て）の最中は動いていると言う', () => {
  assert.equal(screenBusy(undefined, false, 1), true);
  assert.equal(screenBusy(undefined, true, 0), true);
});

test('本体が動いていれば動いている。何もしていなければ空いている（対）', () => {
  assert.equal(screenBusy({ busy: true }, false, 0), true);
  assert.equal(screenBusy({ busy: false }, false, 1), true);
  assert.equal(screenBusy({ busy: false }, false, 0), false);
  assert.equal(screenBusy(undefined, false, 0), false);
});
