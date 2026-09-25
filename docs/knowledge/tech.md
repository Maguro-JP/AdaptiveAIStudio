# 技術の知識

採用技術、ライブラリ、API、環境固有の問題、設計上の知識。新しいものを上に足す。
経緯の長いものは `docs/DECISIONS.md` に書き、ここには一行と参照だけを置く。

## 2026-09-25 draft で作ってすぐ ready にすると、CI が 2 回起きる
- `ci.yml` の `pull_request` は `types: [opened, synchronize, reopened, ready_for_review]`。draft で開いた時点（opened）と ready にした時点（ready_for_review）で 1 回ずつ起きる
- #36・#37・#38 の run 130/131、132/133、134/135 がこの形（同じ head sha で 2 回）。直後にマージするなら opened の回は無駄
- ready の回は Windows も回る（draft の間は止めている）。二つの回は同じ concurrency の組なので、ready が 4 分以内なら opened の回は打ち切られる（run 128 の `cancelled`）。余分に払うのは打ち切られるまでの分（1 分ほど）で、4 分ではない（09-25 の日報の見積もりは多すぎた）
- 塞ぎ方: `ci.yml` の ubuntu の仕事は「draft で開いた」回だけ回さない（09-25。`docs/DECISIONS.md`「draft で開いた一回は、ubuntu も回さない」）

## 2026-09-24 きれいだったファイルの「前」は、HEAD から作業ツリーの形で取れる
- `git cat-file --filters HEAD:./道`（cwd からの相対）。`--filters` で `core.autocrlf` の変換まで作業ツリーの形になる。blob のまま書き戻すと Windows で全行が差分になる
- 無い道（新しく作られた）は非ゼロで終わる → 「前は無い」。大きさは `git cat-file -s` で先に見て、「在るが取れない」を「無い」と分ける
- 索引（`:./道`）は `git add` / `git rm` / `git mv` で動くので「前」にならない。HEAD は `git commit` でしか動かない
- `git rev-parse --show-prefix` は cwd の根からの道（`sub/`、根なら空）。`--show-toplevel` は実体の道なので、シンボリックリンク越しの cwd から `relative()` を取ると `../../` になる
- `git status --porcelain=v1 -z` で R / C の元の名前は次の欄に来る（`新\0元\0`）
- `git status` は同じ道を二行で出すことがある（`git rm --cached` の後は `D ` と `??`）。道を鍵にした Map は後の行で上書きされる
- `git ls-tree -l -z HEAD -- ./道` は一度で、在るか・mode（100644 / 120000 リンク / 160000 submodule）・大きさを返す
- Node の `fs.writeFile` / `stat` はリンクを辿る。作業場の中に置かれたリンクへ書くと、外のファイルを書く。`lstat` で見て、リンクは消してから書く
- `npm install` の `prepare` は引数なしの `npm install` と `npm ci` で走る。`npm i --no-save x` では走らない
- `toolStart` はツールが動く前に届く（`src/agent/loop.ts` の `yield` が先）。ここで作業場の記録を取れば、ツールが触る前の姿になる
- 一つの Session で続けて送る試験は、fake-server の `steps` が履歴のツールの数で段を決めるので、回ごとに `session.reset()` で履歴を空にする（覚えたもの＝ベースラインは残る）

## 2026-09-24 CI は `.claude/` の .md 以外を触った PR でも起動する
- `ci.yml` の `paths-ignore` は `**.md` `docs/**` `.gitignore` `.gitattributes` だけ。スキルの `SKILL.md` と `LESSONS.md` だけの PR（#26 #27 #29 #30）は起動しなかったが、`.claude/settings.json` や `.claude/**/*.sh` を触った PR（#22 #25 #32）は起動した（run 119・121・126）
- 枠が戻ると、これらは ubuntu の 4 分ぶんずつ払う。`.claude/**` を足すかは判断が要る（`settings.json` の `permissions.deny` はハーネスの中身）

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
