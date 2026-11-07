# 働くかの確かめ（2026-11-08）

`scripts/check-work.mjs` で、この機械（Linux）の配る形（`npm run bundle`）を起こし、本物の Qwen3.5-4B-Q4_K_M に画面の入力欄から `checks/work.json` の全部を頼んだ結果。
判定は答えの中身（天気は Open-Meteo、LTS は nodejs.org と突き合わせ）と、出来たファイルを node で動かした出力で見た。
Windows の setup.exe で入れた形では、まだ回していない（CI の `work`）。

| id | 頼み | 1 回目 | 2 回目 | 原因 | 直し |
|---|---|---|---|---|---|
| weather-tomorrow-place | 明日の東京の天気は? | PASS | PASS | （前は問いの決まりが「天気は分かりません」と言わせ、今の事実を取る口も無かった） | Open-Meteo を取る口（`WeatherSource`）と、問いの決まりの書き直し |
| weather-tomorrow-default | 明日の天気は? | PASS | PASS | 同じ | 既定の場所（設定の `location`、東京） |
| weekday-today | 今日は何曜日? | PASS | PASS | （問いの決まりに今日の日付が無かった） | 問いの決まりの末尾に日本時間の日付と曜日（`nowLine`） |
| arithmetic | 1234 × 5678 は? | FAIL（7001052 と答えた） | PASS | 4B が掛け算を間違える | 問いの中の式をこの機械で計算し、値を system に載せる（`src/core/arithmetic.ts`、`test/weather.test.ts`） |
| node-lts | Node.js の今の LTS の版は? | PASS | PASS | （配布の一覧を取る口が無かった） | `NodeReleaseSource` |
| summary-ja | 3 文の要約 | PASS | PASS | | |
| task-hello | hello.js を作る | PASS | PASS | | |
| task-fix-calc | calc.js の引き算を直す | PASS | PASS | | |

気づいたこと（直していない）: 1 回目の task-fix-calc の最後の答えが「TASK_DONE ファイルの作成がブロックされました。別の方法を考えます。」だった。ファイルは直っていて判定は通ったが、終わりの合図が本文に残り、画面の言うことと結果が食い違っている。2 回目には出なかった。原因は調べていない。
