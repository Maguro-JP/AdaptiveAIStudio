# 問題の記録

起きたバグ、原因、解決、再発防止、失敗した手、採用しなかった案と理由。新しいものを上に足す。
自分の判定の誤りは `.claude/skills/lessons/LESSONS.md`、ここはプロダクトの問題。

## 2026-09-25 作業場にしか無いファイルを読む試験が、bundle の中で落ちた（二度目）
- 原因: `test/docs-only-push.test.ts` に足した「ci.yml の並びと突き合わせる」試験が、bundle に入らない `.github/workflows/ci.yml` を開いていた。09-24 の `test/hooks.test.ts` と同じ形
- 解決: その試験を bundle の中では飛ばす（`pushed-tree.test.ts` と同じ判じ方）
- 再発防止: `test/source-only.test.ts`。`join(...)` で `.github` か `.githooks` を開く試験のファイルが `skip` を持たなければ落とす

## 2026-09-25 段取りの担当が `run_command` で書いたファイルが「戻す」に載っていなかった
- 原因: 段取りの経路は `beforeWrite`（この場所の書くツールだけ）しか通っていなかった。送り口の前後比べは段取りには入っていなかった
- 解決: 依頼全体を一度の前後比べで挟む（`plan()` の `team.run` の手前と終わり）。並列の担当を切り分けなくてよい
- 再発防止: `test/plan-outside-undo.test.ts`
- 分かったこと: 段取りの既定の担当（worker）は MCP を持たない（持つのは外を調べる役だけ）。`run_command` は `;` で二つのコマンドに分けて読み、後ろも許可の一覧で見る

## 2026-09-24 bundle の中の `npm test` で、`test/report.test.ts` が runner の側で一度だけ落ちた
- 症状: 中の 6 件は全部 ok なのに、ファイル単位が `Unable to deserialize cloned data due to invalid or unsupported version.`（`node:internal/test_runner/runner` の `#processRawBuffer`）で not ok。`check:bundle` の 4 回のうち 1 回
- 原因（09-25 に見つけた。再現はできていないので、いちばんあり得る形）: 「記録の節も伏せてから出す」の試験だけが `doctor` を渡しておらず、根を一時のフォルダにしたまま本物の doctor を子で起こしていた。子は `MODULE_NOT_FOUND` で落ち、その出力を `runDoctor` が行の区切りに関係なく `process.stdout.write` でそのまま流す。試験のプロセスの標準出力は runner の記録の道なので、割り込んだ出力で枠が崩れうる
- 対処: その試験にも `doctor` を渡し、試験の中で子を起こさない（09-25）
- 残り: `runDoctor` が子の出力を行の区切りに関係なく流す作りはそのまま（利用者の端末では問題にならない）。再発したらそこを行ごとに流す

## 2026-09-24 巻き戻しがリンクを辿って作業場の外を書き、二進を別の中身にして戻し、`??` の在るファイルを消していた
- 原因: `writeFile` はリンクを辿る／前の中身を utf8 の文字列で持っていた／`??` を「前は無い」と読んでいた（`git rm --cached` と `git mv` 後の再エクスポートで在るファイルが `??` になる）／戻せなかった道を `catch {}` で黙って落としていた
- 解決: 置き戻しを `src/harness/put-back.ts` に集め（`lstat`、リンクは消してから書く、親の実体で外を断る、消す道を先に）、`Checkpoint.restoreAll` が戻せなかった道を返す。`textOf` で往復で戻る文字列だけ持つ。`headContent` は `ls-tree -l` で種類と大きさを見て、`??` でも HEAD を引く
- 再発防止: `test/put-back.test.ts`、`test/outside-changes.test.ts`（`git rm --cached`／`git mv` 後／二進／HEAD がリンク）、`test/outside-changed.test.ts`（三回目も巻き戻す／時間切れを覚えない）
- 見つけ方: マージ後に 5 観点で読ませ、指摘ごとに 2 人に反証させた。自分の一度目の読みでは 6 件、押す前の読み直しで 21 件、マージ後の読み直しで 26 件

## 2026-09-24 fresh clone に pre-push フックが入っておらず、確かめずに push が通った
- 原因: `.githooks/README.md` の「一度だけ打つ」を誰も打たなかった。`core.hooksPath` は clone に付いてこない
- 解決: `npm install` の `prepare` が `scripts/hooks.mjs` で入れる。`npm run check` の始めでも入れる。入っていなければ `test/hooks.test.ts` が落ちる
- 再発防止: 上の三つ。`--no-verify` で押す道は取らない（この session では自動の番人にも止められた）
- 残り: 差分ゼロの push（マージ後に枝を main へ合わせ直す）もフック越しに 12 分の確かめを払う。次の実の push まで remote の枝を触らない

## 2026-09-24 確かめが走っている最中に `git add -A` して、sweep の試しファイルを commit に入れた
- 原因: `scripts/sweep.mjs` は「開いているファイルをもう一度押す」の確かめで `sweep-reopen-probe.txt` を作業場の根に作って消す。その間に `git add -A` した
- 解決: `.gitignore` に `sweep-reopen-probe.txt` を足した。画面の一覧（`src/ui/files.ts`）は `.gitignore` を見ないので、確かめは変わらない。commit は押す前だったので amend で外した
- 残り: 確かめが作る他の一時ファイルが根に増えたら、同じ行を足す

## 2026-09-24 きれいだったファイルの「前」を索引から引いていた。`git add` の後では後の中身になる
- 原因: 索引は `run_command` の `git rm` / `git add` / `git mv` で動くのに、触った後の索引を「前」と読んだ。取れないものを「前は無い」と読み、戻すときに在ったファイルを消す道もあった。`--show-toplevel` + `relative()` は、シンボリックリンク越しの作業場で `../../` の道を作った
- 解決: HEAD から引く（`headContent`。absent / content / unavailable を分ける）。道は `--show-prefix`。名前変更の元も記録する。上限は一つ 8MiB・合計 64MiB。覚えている「前」は回の終わりに書き直す
- 再発防止: `test/outside-changes.test.ts`（`git rm` `mv` `add` の後／HEAD に在るが大きすぎる／シンボリックリンク越し／autocrlf）、`test/workspace-stamp.test.ts`（リンク越しの鍵／名前変更の元）、`test/outside-changed.test.ts`（前の回で落としたまま終えた／戻せなかったものを言う）
- 見つけ方: 押す前に別の担当に読ませた（21 件）。自分で見つけていたのは 6 件

## 2026-09-24 打ち切って巻き戻すと、外のツールが変えた分だけ残った
- 原因: 巻き戻し（Checkpoint）も「戻す」（UndoStore）も、`write_file` / `edit_file` の手前でしか前の中身を記録していなかった。外のツールは何を書くか前もって分からない
- 解決: 外のツールと `run_command` の前後で作業場を比べ、前の中身を「呼ぶ前に読む／HEAD から取る／前は無い」の三つの道で取って載せる（`src/agent/outside-changes.ts`。最初は索引だったが `git add` で動くので HEAD に替えた。上の項）
- 再発防止: `test/outside-changed.test.ts` の「打ち切ったら、外のツールが変えた分も戻す」（本物の git と MCP の代役で通す）
- 採用しなかった案: 外のツールの後に作業前を測る（外のツールが落とした分が「元から」になる）／呼ぶ前に必ず測る（1ターンが何十秒も伸びる）
- 残り: `plan()` と Team の経路は対象外。`.gitignore` の中と git の無い作業場は見えない

## 2026-09-24 「比べられません」を、了解の口も無く毎回出していた
- 原因: 警告を出すだけで、伝わったことを覚える場所が無かった
- 解決: 了解を作業場ごとに本体が覚える（`src/core/acks.ts`）。画面はボタン、CLI は `/ack`。取り消しは設定の「また出す」
- 再発防止: `test/acks.test.ts`、`test/acks-api.test.ts`、`test/panel-outside.test.ts`、`test/outside-changed.test.ts`（了解した作業場では出ない）

## 2026-09-24 外のツールが落としたテストを「作業前から」と読んでいた
- 原因: 作業前の成否を、この場所のツールで書く手前で測っていた。外のツールが先に変えていると、その後の姿を測る
- 解決: 外のツールの手前の作業場の記録と比べ、変わっていたら測らない。落ちたものはこの回のものとして直させる
- 再発防止: `test/outside-changed.test.ts` の「外のツールが先に変えてから、この場所で書いた回」
- 残り: git の管理下でない作業場では比べられないので、これまでどおり測る

## 2026-09-24 外のツールだけで書いて終わった回が、確かめずに「完了」になっていた
- 原因: 作業後の確かめは、この場所のツールの手前で作業前の成否を測った回だけ回る
- 解決: 外のツールの手前で作業場の印を取り、回の終わりに変わっていたら一度だけ確かめる（直させない）
- 再発防止: `test/outside-changed.test.ts`（MCP の代役を本当に繋いで通す）
- 採用しなかった案: 必ず確かめる（読むだけで待たされる）／直させる（元からの失敗を直しにいく）
- 残り: `.gitignore` の中だけの変化は見えない。git の無い作業場では比べられない

## 2026-09-24 外のツールが先に消したテストを、作業後の確かめが見逃していた
- 原因: テストの数の記録を `changesFilesHere`（この場所のツール）の手前でだけ取っていた。MCP のツールが先に消すと、消した後の数が「作業前」になる
- 解決: 数の記録だけ `mayChangeFiles` の手前にも広げた（`src/agent/before-work.ts`）
- 再発防止: `test/before-work.test.ts`（本物のディレクトリで、消す → 書く）
- 採用しなかった案: 成否も外のツールの手前で測る。e2e が打ち切られた（2026-09-23 に実測）
- 残り: 解消（外のツールだけの回は一度だけ確かめる。先に変えてから書いた回は作業前を測らない。どちらも 2026-09-24）
