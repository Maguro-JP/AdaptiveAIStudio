# 技術の知識

採用技術、ライブラリ、API、環境固有の問題、設計上の知識。新しいものを上に足す。
経緯の長いものは `docs/DECISIONS.md` に書き、ここには一行と参照だけを置く。

## 2026-09-24 claude.ai のクラウドでも、画面を押して確かめられる
- `ln -sfn /opt/node22/lib/node_modules/playwright/node_modules/playwright-core node_modules/playwright-core` を張ると、`npm run check` が sweep まで回す（`node_modules/` は git の外）
- sweep は `networkidle` で開いていたので、`/api/events`（EventSource）が開きっぱなしのこの環境では 30 秒で切れていた。画面が「つながっています」（`#status.live`）になるのを待つ形に替えて通った（`scripts/sweep.mjs` の `opened`）
- `scripts/shot.mjs` はまだ `networkidle`。README の画面を撮り直すときに同じ所で止まる見込み（確かめていない）

## 2026-09-24 作業場が変わったかは、git に聞いて安く見分ける
- `git status --porcelain=v1 -z --untracked-files=all` の各ファイルに、大きさと更新時刻を添えた印を前後で比べる（`src/agent/workspace-stamp.ts`）
- きれいなファイルが変われば一覧に出る。もともと変わっていたファイルは大きさか時刻が動く
- MCP のツールの名前は `<サーバ名>__<ツール名>`。Session に載ったかは `session.toolPool.mcp` の `schema.name` で見る（繋がるのは Session.create の後）

## 2026-09-24 作業前の記録は二つあり、重さが違う
- テストの数（`snapshotTests`）はディレクトリを歩くだけで軽い。作業前の成否（ベースライン）はテストを一度走らせるので重い
- 軽い方は外のツール（MCP）の手前でも取れる。重い方は取れない（1ターンが何十秒も伸びる）
- まとめてある所: `src/agent/before-work.ts`
