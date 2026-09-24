# 技術の知識

採用技術、ライブラリ、API、環境固有の問題、設計上の知識。新しいものを上に足す。
経緯の長いものは `docs/DECISIONS.md` に書き、ここには一行と参照だけを置く。

## 2026-09-24 CI は `.claude/` の .md 以外を触った PR でも起動する
- `ci.yml` の `paths-ignore` は `**.md` `docs/**` `.gitignore` `.gitattributes` だけ。スキルの `SKILL.md` と `LESSONS.md` だけの PR（#26 #27 #29 #30）は起動しなかったが、`.claude/settings.json` や `.claude/**/*.sh` を触った PR（#22 #25 #32）は起動した（run 119・121・126）
- 枠が戻ると、これらは ubuntu の 4 分ぶんずつ払う。`.claude/**` を足すかは判断が要る（`settings.json` の `permissions.deny` はハーネスの中身）

## 2026-09-24 作業前の記録は二つあり、重さが違う
- テストの数（`snapshotTests`）はディレクトリを歩くだけで軽い。作業前の成否（ベースライン）はテストを一度走らせるので重い
- 軽い方は外のツール（MCP）の手前でも取れる。重い方は取れない（1ターンが何十秒も伸びる）
- まとめてある所: `src/agent/before-work.ts`
