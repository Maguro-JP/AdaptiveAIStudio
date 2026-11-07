# 働き方

利用者が Ciel と作ってきたスキル（`.claude/skills/`）と、CLAUDE.md の「ユーザーの決めたこと」を、
製品の中のエージェントがどこで守るかの対応。守らせたいことは文章でお願いせず、実行の手前で止める。
止められないものだけを、既定のシステムプロンプト（`src/core/session.ts` の `DEFAULT_SYSTEM`）に短く書く。

守らせ方は 3 つ。

- コード: 作業ループやハーネスが、返事やツールの呼び出しを見て止める・押し戻す
- プロンプト: システムプロンプトに書く。モデルが守るかは確かめていない
- 画面: アプリの画面の作りで守る

## 対応

| スキル | 製品の中で守る所 | 守らせ方 |
|---|---|---|
| verify-before-done | 「テストが通りました」「動きました」と言うのに、この依頼で run_command が一度も成功していなければ一度押し戻す（`src/agent/work-style.ts` の `claimsVerified`、`src/agent/loop.ts`） | コード |
| verify-before-done | 終わりは決めた一語（`TASK_DONE`）で受け、合図なしで手を止めたら押し戻す（`src/agent/done.ts`） | コード |
| work-style | 作業のあとの確かめ（`src/agent/verify.ts`）、作業前のベースライン（`src/agent/baseline.ts`） | コード |
| prompt-from-context | 「続けて」「それも」だけの一言は、前の依頼をシステムプロンプトの末尾に添え、聞き返させず、読んだ形を ↩ の1行で書かせる（`expandShortUtterance`） | コード＋プロンプト |
| user-emotion | いらだちの一言を読み取り、嫌がられたこととして覚え、次からシステムプロンプトに載せる（`src/memory/displeasure.ts`） | コード |
| lessons | 失敗を覚え、同じ場面で思い出して載せる（`src/memory/memory.ts`、`src/memory/builtin-lessons.ts`） | コード |
| follow-instructions | 書き込みと危ない命令は利用者の許可を通す（ハーネス `src/harness/gate.ts`）。訂正は1文で認めて直す、代案は後に1行 | コード＋プロンプト |
| finish-first | 成果物を一つずつ仕上げる。作業の分け方（`src/agent/decompose.ts`）と自律の目標（`src/core/goals.ts`） | プロンプト |
| user-terms | 利用者の語で書く、訳語や造語を作らない。製品のソースは `test/wording.test.ts` が止める | プロンプト＋テスト |
| ui-design / desktop-app | アプリのウィンドウで開く画面（`src/ui/`、`src/core/app-window.ts`）。設計は docs/UI.md | 画面 |
| 時刻（日本時間） | システムプロンプトに書く | プロンプト |
| ★ ↩ ❕ ❔ の4種類の行 | ↩ だけを短い一言の読み取りで使う。ほかは画面の札（承認・知らせ）がその役をする | 一部コード |
| background-first | 長い作業は裏の役職とチーム（`src/agent/team.ts`）に出し、画面は止めない | コード |
| token-efficiency | システムプロンプト全体を一つの予算に収める（`fitParts`）、ツールの説明を削る（`src/agent/window.ts`） | コード |

## Claude Code だけのもの（製品には入れない）

| スキル | 理由 |
|---|---|
| solo-pr-flow、ci-triage、tidy、workspace-policy | GitHub の PR とブランチの運用。製品のエージェントは手元の作業場で動き、PR を作らない |
| skill-sync、skill-upkeep、skill-request、skill-audit、repo-bootstrap | Ciel のスキルを配る・育てる仕組みそのもの |
| auto-dev、long-dev、scheduler、patrol、pending、session-watch、feedback-session | Claude Code のセッションとルーティンの運用。製品の自律は `src/harness/idle.ts` が別に持つ |
| dev-report | このリポジトリの開発の報告 |
| vuln-watch、secret-leak-check、content-audit | リポジトリの公開と依存の見張り。製品の中の守り（鍵の形を止める、外から入る中身の検問）は別にある |
| ja-proofread、docs-upkeep | このリポジトリの文書の手入れ |
| shared-models | 製品はすでに `C:\LLM\gguf` を使う（`src/core/home.ts`）。スキルとしては入れない |
| self-learn | 製品では知識の蔵（`src/core/knowledge.ts`）が受け持つ |

## 確かめたこと・確かめていないこと

- コードで守るものは `test/work-style.test.ts` で、偽のモデルの返事を流して確かめる
- プロンプトで守るものを、中の 4B のモデルが守るかは確かめていない
