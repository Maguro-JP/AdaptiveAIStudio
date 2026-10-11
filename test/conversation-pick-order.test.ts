/**
 * 一覧で会話を素早く二つ押しても、最後に押した会話が開く（DECISIONS 10-11、104 回目）。
 *
 * 押すたびに選びの問い合わせを並べて投げ、返事の届いた順に欄を描き直していたので、先の返事が後に届くと、画面は先に
 * 押した会話を出し、本体が見ている会話と食い違いえた。押した順に一つずつ流す。
 * 画面を走らせずに確かめる手が無いので、書き方で止める（振る舞いは確かめていない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(root, 'src/ui/web/app.js'), 'utf8').replace(/\r\n/g, '\n');

test('会話を開く問い合わせは、一つの列に並べて順に流す', () => {
  assert.match(app, /^let selecting = Promise\.resolve\(\);$/m, '列が無い');
  assert.match(app, /open\.onclick = \(\) => \{ selecting = selecting\.then\(pick, pick\); return selecting; \};/,
    '押すたびに列を通さずに問い合わせている');
  assert.doesNotMatch(app, /open\.onclick = async \(\) => \{\n\s*const r = await ask\('\/api\/conversations\/select'/,
    '列を通さずに選びを投げる形が残っている');
});

test('トップから送っている間も、送る前から動いていた会話の出来事は弾く', () => {
  // 全部通していたので、返事を待つ数秒の間、横で走る別の会話の答えが新しい会話の欄に混ざった
  assert.match(app, /function notViewed\(id\) \{\n\s*if \(conversations\.current\) return id !== conversations\.current;\n\s*return !sendingFromTop \|\| runningAtSend\.has\(id\);/);
  assert.doesNotMatch(app, /conversations\.current \? e\.conversationId !== conversations\.current : !sendingFromTop/,
    '送る前から動いていた会話を見ずに通す形が残っている');
});
