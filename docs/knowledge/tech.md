# 技術の知識

採用技術、ライブラリ、API、環境固有の問題、設計上の知識。新しいものを上に足す。
経緯の長いものは `docs/DECISIONS.md` に書き、ここには一行と参照だけを置く。

## 2026-09-24 claude.ai のクラウドでも、`npm run check` を飛ばさずに回せる
- 読む側: `npm i --no-save --no-audit --no-fund node-llama-cpp @node-llama-cpp/linux-x64`（CI の `real` と同じ入れ方）。`--omit=optional` を付けると、このプロジェクトの任意の依存 `@anthropic-ai/sdk` まで外れて型検査が落ちる。付けない（GPU 用の部品で node_modules が 765MB になる）
- 画面: `ln -sfn /opt/node22/lib/node_modules/playwright/node_modules/playwright-core node_modules/playwright-core`。`npm i` のたびにこのリンクは外されるので、入れた後に張り直す
- 両方あると「中で読む道」「本物の数え方（649 件一致）」「CI へ出す前の配管」「sweep」まで回る。飛ばすのは 3 件だけ。1回 10 分を超える
- `npm run check:bundle` も同じ状態で最後まで回る（配る形の中でテスト・smoke の「送って返る」・sweep）。node-llama-cpp が無いと smoke の「返ってくる」だけが NG になる
- sweep は `networkidle` で開いていたので、`/api/events`（EventSource）が開きっぱなしのこの環境では 30 秒で切れていた。画面が「つながっています」（`#status.live`）になるのを待つ形に替えて通った（`scripts/sweep.mjs` の `opened`）
- `scripts/shot.mjs` も同じ所で止まっていた（`page.goto: Timeout 30000ms exceeded`）。同じ待ち方に替えて撮れた（作業用の場所へ撮って確かめた。README の画像は差し替えていない）

## 2026-09-24 作業場が変わったかは、git に聞いて安く見分ける
- `git status --porcelain=v1 -z --untracked-files=all` の各ファイルに、大きさと更新時刻を添えた印を前後で比べる（`src/agent/workspace-stamp.ts`）
- きれいなファイルが変われば一覧に出る。もともと変わっていたファイルは大きさか時刻が動く
- MCP のツールの名前は `<サーバ名>__<ツール名>`。Session に載ったかは `session.toolPool.mcp` の `schema.name` で見る（繋がるのは Session.create の後）

## 2026-09-24 作業前の記録は二つあり、重さが違う
- テストの数（`snapshotTests`）はディレクトリを歩くだけで軽い。作業前の成否（ベースライン）はテストを一度走らせるので重い
- 軽い方は外のツール（MCP）の手前でも取れる。重い方は取れない（1ターンが何十秒も伸びる）
- まとめてある所: `src/agent/before-work.ts`
