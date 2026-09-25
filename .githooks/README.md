# push の手前で止める

`pre-push` が `node scripts/check.mjs`（型チェック → テスト → 画面を押して回る）を回す。
落ちたら push できない。

入れるのは `npm install`（package.json の `prepare` が `scripts/hooks.mjs` を呼ぶ）。
`npm run check` の始めでも入れる。手で入れるなら `npm run hooks`
（中身は `git config core.hooksPath .githooks`）。

「新しく clone したときは一度だけ打つ」と書いていたが、fresh clone で誰も打たず、
フックが無いまま push が通った。`test/hooks.test.ts` は、本物の clone に入ることを見る
（この作業場の状態は見ない。CI は `npm ci` の前に `npm test` を回す）。

押すツリーが外の main と同じ（マージの後にブランチを main へ合わせ直すなど）なら、確かめを飛ばして
理由を一行言う（`scripts/same-as-main.mjs`）。外に新しく出るものが無いため。
