# 働くかの確かめ（check-work）

起動の確かめ（`scripts/check-user.mjs`）とは別に、本物のモデルが頼みに働くかを確かめる。
入れた形の本体を起こし、画面の入力欄から質問と作業を頼み、答えの中身と出来たファイルで判定する。

## 回し方

```
node scripts/check-work.mjs --start "sh dist/AdaptiveAIStudio/app/start.sh ui" --port 4176
```

Windows に入れた形なら、`--start` に入口（`AdaptiveAIStudio.vbs` を wscript.exe で起こす命令）を渡す。CI では、手で回すときの `work` を選ぶ。

- `--work <フォルダ>` 作業場（作業の頼みでファイルを作らせる所）。省略すると一時フォルダ
- `--shots <フォルダ>` 1 件ごとの画面の写し
- `--out <ファイル>` 結果を JSON で残す

1 件ごとに `== PASS <id>: 理由 ／ 答え: …` か `== FAIL …` を出し、最後に `== 結果: 通った数/全部` を出す。1 件でも落ちたら 1 で終わる。

## 既定の一覧

`checks/work.json`。毎回全部を回す。足すだけにし、消さない・skip しない。
一度載せた id は `checks/work.ids` に足す。消えると `test/work-checks.test.ts` が止める。

1 件は `{ "id", "kind": "answer" か "task", "ask", "judge" }`。作業の頼みで先に置くファイルがあれば `setup: { file, content }`。

| judge の type | 見るもの |
|---|---|
| `contains-all` / `contains-any` | 語が入っているか（`values`、`any`） |
| `regex` | 正規表現に合うか（`pattern`） |
| `number-equals` | 数が入っているか（`value`。カンマ入りも読む） |
| `not-contains` | 入っていてはいけない語 |
| `weather-matches-open-meteo` | 晴/曇/雨/雪 と ℃（度）を言い、Open-Meteo の明日の予報と組か気温（±3℃）が合うか（`place`。`@default` は設定の天気の場所） |
| `weekday-jst` | 日本時間の今日の曜日だけを言うか |
| `node-lts-matches` | nodejs.org の今の LTS の版が入っているか |
| `file-runs` | 作業場に `file` が出来た（直った）か。node で動かした出力が `stdout` と同じか |

どの答えの判定でも、「分かりません」の類で終えた答えは落とす。

## その時に試したいもの（足すだけ）

既定の一覧に足して回す。代わりにはならない。

- `--ask "<質問>" --expect "<正規表現>"` 質問を 1 件足す
- `--task "<頼み>" --file <名前> --stdout "<出力>"` 作業を 1 件足す
- `--list <自分の一覧.json>` 同じ形の一覧を足す（id の頭に `list:` が付く）
