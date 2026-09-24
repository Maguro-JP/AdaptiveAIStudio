# push の手前で止める

`pre-push` が `node scripts/check.mjs`（型チェック → テスト → 画面を押して回る）を回す。
落ちたら push できない。

入れるのは `npm install`（package.json の `prepare` が `scripts/hooks.mjs` を呼ぶ）。
`npm run check` の始めでも入れる。手で入れるなら `npm run hooks`
（中身は `git config core.hooksPath .githooks`）。

「新しく clone したときは一度だけ打つ」と書いていたが、fresh clone で誰も打たず、
フックが無いまま push が通った。入っていなければ `test/hooks.test.ts` が落ちて言う。
