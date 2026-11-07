/**
 * 確かめの質問・作業・試験は足すだけ（CLAUDE.md「ユーザーの決めたこと」）。
 * 一度載せた id が消えた・skip にした、check-user の頼みが減った、を止める。判定そのものも偽の正解で見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error 型の無い .mjs
import { judgeAnswer, adHocChecks, weatherGroup } from '../scripts/work-judge.mjs';

const root = join(import.meta.dirname, '..');
const list = JSON.parse(readFileSync(join(root, 'checks', 'work.json'), 'utf8')) as { checks: Record<string, unknown>[] };
const ids = readFileSync(join(root, 'checks', 'work.ids'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

describe('確かめは足すだけ', () => {
  test('一度載せた id は、全部いまの一覧にある', () => {
    const now = new Set(list.checks.map((c) => c.id));
    const gone = ids.filter((id) => !now.has(id));
    assert.deepEqual(gone, [], `一覧から消えた確かめ: ${gone.join(', ')}（消さない。checks/work.ids は足すだけ）`);
  });
  test('一覧の id は全部 checks/work.ids に記録してある', () => {
    const rec = new Set(ids);
    const unrecorded = list.checks.map((c) => String(c.id)).filter((id) => !rec.has(id));
    assert.deepEqual(unrecorded, [], `checks/work.ids に足していない: ${unrecorded.join(', ')}`);
  });
  test('skip・無効の項目が無い', () => {
    for (const c of list.checks) {
      for (const k of ['skip', 'disabled', 'enabled', 'only', 'todo']) assert.equal(k in c, false, `${String(c.id)} に ${k} がある`);
    }
  });
  test('check-work に絞る・飛ばす口が無い', () => {
    const src = readFileSync(join(root, 'scripts', 'check-work.mjs'), 'utf8');
    for (const flag of ['--only', '--skip', '--exclude']) assert.equal(src.includes(flag), false, `${flag} がある`);
  });
  test('check-user の頼み（fizzbuzz、calc、glob）が全部残っている', () => {
    const src = readFileSync(join(root, 'scripts', 'check-user.mjs'), 'utf8');
    for (const name of ['fizzbuzz.js', 'calc.js', 'glob.js']) assert.ok(src.includes(name), `${name} の頼みが消えた`);
    for (const k of ['const ASK', 'const FIX_ASK', 'const NEW_ASK']) assert.ok(src.includes(k), `${k} が消えた`);
  });
});

describe('答えの判定（中身で見る）', () => {
  const weather = { code: 61, max: 17.4, min: 12.3 };
  test('天気: 雨と気温が合えば通す。分かりませんは落とす', () => {
    const j = { type: 'weather-matches-open-meteo', place: '東京' };
    assert.equal(judgeAnswer(j, '明日の東京は雨、最高 17℃ です。', { weather }).ok, true);
    assert.equal(judgeAnswer(j, '明日の天気は分かりません。', { weather }).ok, false);
    assert.equal(judgeAnswer(j, '明日は晴れです。', { weather }).ok, false, '気温が無い');
    assert.equal(judgeAnswer(j, '明日は晴れ、最高 30℃。', { weather }).ok, false, '組も気温も違う');
    assert.equal(weatherGroup(3), '曇');
  });
  test('曜日: 日本時間の曜日だけを言えば通す', () => {
    const j = { type: 'weekday-jst' };
    assert.equal(judgeAnswer(j, '今日は日曜日です。', { weekday: '日' }).ok, true);
    assert.equal(judgeAnswer(j, '今日は月曜日です。', { weekday: '日' }).ok, false);
  });
  test('数: カンマ入りでも読む', () => {
    assert.equal(judgeAnswer({ type: 'number-equals', value: 7006652 }, '7,006,652 です').ok, true);
    assert.equal(judgeAnswer({ type: 'number-equals', value: 7006652 }, '7006650 です').ok, false);
  });
  test('LTS: 正解の版が入っていれば通す', () => {
    assert.equal(judgeAnswer({ type: 'node-lts-matches' }, 'LTS は v26.13.0 です', { lts: 'v26.13.0' }).ok, true);
    assert.equal(judgeAnswer({ type: 'node-lts-matches' }, 'LTS は v22 です', { lts: 'v26.13.0' }).ok, false);
  });
  test('その回だけの確かめは、作って足す', () => {
    const got = adHocChecks(['--ask', 'Q', '--expect', 'A', '--task', 'T', '--file', 'x.js', '--stdout', 'ok']);
    assert.equal(got.length, 2);
    assert.equal(got[1].judge.file, 'x.js');
  });
});
