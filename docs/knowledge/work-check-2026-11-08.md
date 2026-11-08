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

## Windows の setup.exe で入れた形（CI の `work`、run 42427979607、07935da）: 5/8

本物の Qwen3.5-4B を、setup.exe で入れたアプリのウィンドウ（GUI）で回した結果。artifact（work-shots）の会話と ui.log を読んで原因を確かめた。

| id | 結果 | 原因（会話と ui.log で確かめたこと） | 直し |
|---|---|---|---|
| weather-tomorrow-place | FAIL（答えが空です） | 作業場を変えた直後で本体（Session）が畳まれており、最初の依頼はモデルの読み込みから始まった。`/api/approvals` の busy は本体があるときだけ見ていたので、支度の最中に「空いている」と返し、確かめは送って 5 秒で空の答えを読んだ。答えは 1 分後に会話に残っていた（中身は「知識の蔵から晴れ、22 度」で、正しくはない） | busy を、本体が無くても支度（`#prep`）と考えごとを数える形に（`screenBusy`、`test/screen-busy.test.ts`） |
| weather-tomorrow-default | FAIL（正解を取れませんでした） | 本体の答え（雨、最高 10.7℃）は合っていた。判定の側が Open-Meteo を一度取り損ねると、取り直さず、理由も残さず落としていた。理由は確かめられていない（記録が無い） | 判定は本体と同じ `WeatherSource.forecast` で取り、4 回まで間を空けて取り直し、取れなければ理由を添える（`scripts/work-judge.mjs`、`test/work-checks.test.ts`） |
| task-hello | PASS（答えは混乱） | 「TASK_DONE だけの行を書いてください」を、`TASK_DONE` というファイルを書けと読み、`write_file` で TASK_DONE を作り、同じ書き込みの禁止・rm の禁止で 15 分回り、noProgress で終えた。次の依頼に「触ったもの: hello.js, TASK_DONE」が持ち越された | ファイルのツールに `path: TASK_DONE` を渡した呼び出しを終わりの合図として受け取り、走らせない（`isDoneCall`）。押し戻しの文に「合図はファイルではない」と書く（`test/nudge.test.ts`） |
| task-fix-calc | FAIL（calc.js が直っていない） | 会話では「修正します」と言って `read_file` は呼んでいた。その次の回（入力 3722 トークン）で、最初の 1 トークンの後に 10 分以上何も来ず、`inproc が 120秒 応答しませんでした（停滞）` で落ちた（ui.log 09:56:48）。なぜ黙ったか（ツールの引数を組んでいたのか、繰り返しか）は確かめていない | ツールを一度も呼ばずに「修正します」と言うだけで返した回を、一度押し戻して実行させる（`announcesAction`、`test/nudge.test.ts`）。停滞そのものは直していない |

ほかの 4 つ（曜日、掛け算、Node.js の LTS、要約）は PASS。
