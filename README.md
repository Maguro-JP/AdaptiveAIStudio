# AdaptiveAIStudio

AIサービスの利用制限・障害・提供終了に開発が左右されない、
個人向けの長期運用可能なAI開発基盤。

## 目的

- 開発を止めない
- 利用制限に依存しない
- AIサービス終了に依存しない
- モデルを自由に交換できる
- 自分専用の開発環境を構築する

Claudeの代替を作ることが目的ではない。
Claudeが使えるときはClaudeを使い、制限・障害時にLocalLLMへ切り替えて開発を継続する。

## 基本原則

1. **モデル依存禁止** — Claude専用/Ollama専用のような構成は作らない
2. **UIはモデルを知らない** — UIはProvider Layer経由でのみモデルへ到達する
3. **交換可能性が最優先** — 新モデルはアダプタ追加のみで導入できる
4. **ローカルファースト** — データは自分の手元に置き、クラウドは任意

## 使い方 (MVP)

Node.js 22.6以降のみ必要。ビルド不要・実行時依存ゼロ。

### 1. モデルを用意する

**ローカル:**

```
ollama serve
ollama pull qwen3:30b-a3b
```

**7B を既定にしない。** ローカルにはトークン単価が無いので、
節約のために弱いモデルを使う理由がない。
RTX 4060 (8GB) では MoE の `qwen3:30b-a3b` が最適解
（30B級の質を約33 tok/s で出せる）。詳細は
[モデル運用](docs/MODEL-EFFICIENCY.md) と [32B級を動かすには](docs/RUNNING-LARGE-MODELS.md)。

**Claude (任意):**

```
set ANTHROPIC_API_KEY=sk-ant-...
```

設定しなければローカルのみで動作する。

### 2. 設定する（任意）

**モデルの指定は不要。** 起動時にマシンと導入済みモデルを調べ、
自動操縦が最良のものを選び、実測に応じて裏で乗り換える。

```
環境: NVIDIA GeForce RTX 4060 8GB / RAM 32GB
担当モデル: ollama:qwen3:30b-a3b
  起動時の自動選択 — 33 tok/s で 36秒 / 成功率 65%(事前値) / 1件あたり約72秒
```

`/models` で候補の順位と理由、`/metrics` で実測の蓄積を確認できる。

モデルを固定したいのは比較検証をするときだけなので、
`candidates` は書かなくてよい（書けば固定される）。

クラウド（Claude）は **既定で無効**。ローカルだけで完結する。
使いたいときだけ `enabled: true` にする。


```
cp aas.config.example.json aas.config.json
```

省略した場合は `ollama:qwen2.5-coder:7b` を既定として起動する。
`candidates` は先頭から順に試され、利用制限や障害で使えなければ次へ自動で切り替わる。

### 3. 起動する

**エージェント（作業者に実装させる）:**

```
npm run agent
```

```
依頼> add関数のバグを直して
  · read_file app.ts
    ✓ 1	export function add(a: number, b: number): number {
  · write_file app.ts

  変更: app.ts
  @@ -1,4 +1,4 @@
   export function add(a: number, b: number): number {
  -  return a - b;
  +  return a + b;
   }
  許可しますか？ [y/N] y
    ✓ 更新: app.ts（+1 -1）

  完了 (2.8s)
```

**チーム（複数の作業者を並列で動かす）:**

```
npm run team -- tasks.json
```

```
▶ auth    [coder]
▶ session [coder]
▶ logger  [cpu]
✓ auth    (1.5s)
✓ session (1.5s)
▶ index   [coder]        ← auth と session の完了を待って開始
✓ logger  (1.5s)
✓ index   (1.4s)
完了 4/4
```

`tasks.json` は今は手書き。P3 で PM が自動生成するようになる。

```jsonc
[
  { "id": "auth",  "laneId": "coder", "writes": ["auth.ts"],  "instruction": "..." },
  { "id": "index", "laneId": "coder", "writes": ["index.ts"],
    "deps": ["auth"], "instruction": "..." },

  // 同じ作業を複数モデルへ同時に投げ、最初に完了したものを採用する。
  // ローカルは計算が無料なので、遊ばせるより重ねて投げた方が速い。
  { "id": "fix", "laneId": "coder", "writes": ["fix.ts"], "instruction": "...",
    "raceWith": ["ollama:qwen2.5-coder:7b"] }
]
```

レーンは設定で決める。並列度は「同時ロードするモデル数」ではなく
「同一モデルへ同時に流すタスク数」で稼ぐ。

```jsonc
{ "agent": { "lanes": [
  { "id": "coder", "candidates": ["ollama:qwen2.5-coder:7b"], "parallel": 3 },
  { "id": "cpu",   "candidates": ["ollama:qwen2.5:3b"],       "parallel": 2 }
] } }
```

**モデルの一覧と実行計画を見る:**

```
npm run models
```

```
qwen2.5-coder-32b-q4_k_m.gguf (19.8GB)
  部分オフロード (GPU 16/64層) / context 8192 / 約 3 tok/s
  VRAM 7.0GB / RAM 13.8GB
  1000トークンの応答: 約 6分
  劣化: GPU層数を 16/64 に減らした
```

**チャットのみ:**

```
npm run chat
```

```
> このコードのバグを指摘して
ローカルモデルが応答しました。
  — ollama:qwen2.5-coder:7b / 3.2s
```

応答の下に必ず「実際に答えたモデル」が出る。
フォールバックが起きた場合は切替の理由も表示される。暗黙に劣化させないための仕様。

### 自己検証ループ

作業が終わるとテストを流し、失敗したら自分で直させ、通るまで繰り返す。
検証コマンドは先読みが検出する（`npm test` など）。

```
作業前の状態を確認中: npm test
検証 1回目: npm test
✗ 検証に失敗（1回目）
修正させています...
検証 2回目: npm test
✓ 検証を通過しました
```

```jsonc
{ "agent": { "verify": {
  "enabled": true,        // 既定
  "command": "npm test",  // 省略時は自動検出
  "maxRounds": 5,
  "timeBudgetMs": 3600000,
  "baseline": true        // 作業前にも流し、既存の失敗と区別する
} } }
```

**テストを消して通すことは認められません。** 作業前後でテストの規模を比べ、
削除・skip による減少があれば通過とみなしません。

### 安全のしくみ

エージェントは既定で以下に縛られている。

| 制約 | 内容 |
|---|---|
| パス封じ込め | 作業ディレクトリの外は読めない・書けない |
| 書き込み承認 | 承認モードに従う。`ask` なら差分を見せて `y` を得るまで書かない |
| Git確認 | 自動書き込み前に未コミット変更・非git環境を警告する |
| 書き込みロック | 並列時、同じファイルを書く作業者は同時に走らせない |
| コマンド許可リスト | `npm` `node` `git` など既知のコマンドのみ。危険な形は許可リストを通っても拒否 |
| 堂々巡りの停止 | 同じ操作を3回繰り返したら止める |

長時間の自律実行に切り替えたい場合は設定で承認モードを変える。

```jsonc
{ "agent": { "approval": "ask" } }       // 毎回確認する
{ "agent": { "approval": "autoEdit" } }  // 書き込みは自動、コマンドのみ確認（既定）
{ "agent": { "approval": "auto" } }      // 全自動（git管理下での利用を前提）
```

既定は `autoEdit`。自律実行が本題なので、書き込みで毎回止めない。
安全網は Git であり、**開始前に未コミットの変更を警告する**。

### チャットのコマンド

| コマンド | 説明 |
|---|---|
| `/models` | 利用可能なモデル一覧 |
| `/model <id>` | 使用モデルを固定 |
| `/auto` | 固定を解除し設定の候補順に戻す |
| `/health` | 各Providerの到達性と冷却状態 |
| `/new` | 履歴を破棄 |
| `/models` | 候補の順位と選択理由 |
| `/metrics` | 実測の蓄積（成功率・実測速度） |
| `/warm` | 常駐しているモデルの状態 |
| `/context` | 先読みで把握している状況 |
| `/system <文>` | システムプロンプト差し替え |
| `/exit` | 終了 |

生成中の `Ctrl-C` は中断のみ。入力待ちでの `Ctrl-C` は終了。

### テスト

```
npm test        # Provider契約テスト + フォールバック動作テスト
npm run typecheck
```

`test/contract.test.ts` は全Provider共通の適合テスト。
**新しいProviderを追加したら、このスイートを通すことを条件とする。**

---

## 実装状況

土台の配管（モデル交換とフォールバック）は動作する。
**エージェント機能（ファイル編集・複数モデルの役割分担）は未着手。**

| 機能 | 状態 |
|---|---|
| Provider層・正規化エラー・フォールバック・冷却 | 動作 |
| ローカルLLM (Ollama / LM Studio / vLLM / llama.cpp) | 動作 |
| Claude (公式SDK) | 動作。**既定で無効**（ローカルが主） |
| ファイル読み書き・コマンド実行（作業者1名） | 動作 |
| 職能・部署への人材配置 | 未実装 |
| 並列実行（レーン・スケジューラ・書き込みロック） | 動作 |
| 停滞ベースのタイムアウト（低速環境で殺されない） | 動作 |
| 実行可能性プランナ（載らないモデルの実行設定を計算） | 動作 |
| 効率計算（期待実時間でモデルを選ぶ） | 動作 |
| 自動操縦（設定不要でモデルを選び、裏で乗り換え） | 動作 |
| 冗長実行（同じ作業を複数モデルへ同時投入し最速を採用） | 動作 |
| 最良選択（複数の答えを採点して最良を採用） | 動作 |
| マシン検出（GPU/VRAM/RAM） | 動作 |
| 実測の蓄積（成功率・見逃し・実測速度） | 動作 |
| llama.cpp 直接制御ランタイム（S1） | 動作 |
| ランタイム切替（ollama / llamacpp） | 動作 |
| 常時ロード（起動時に温めてロード待ちをゼロに） | 動作 |
| 先読み（待機中に索引・git・テストコマンドを把握） | 動作 |
| 自己検証ループ（テストが通るまで自分で直す） | 動作 |
| 指揮AI・サブエージェント | 未実装 |
| デスクトップUI・クリック起動 | 未実装 |

次に何を作るかは [docs/ROADMAP.md](docs/ROADMAP.md) を参照。

---

## ドキュメント

- [実現計画](docs/ROADMAP.md) — 到達目標と改訂フェーズ（**まずこちら**）
- [組織設計](docs/ORGANIZATION.md) — 職能・部署・人材配置・並列実行の設計
- [パフォーマンスで戦う](docs/PERFORMANCE.md) — 計算が無料な利点をどう使うか（**重要**）
- [最も効率の良いモデル運用](docs/MODEL-EFFICIENCY.md) — 何を基準にモデルを選ぶか（**重要**）
- [32B級を動かすには](docs/RUNNING-LARGE-MODELS.md) — メモリ計算・速度の根拠・MoE・並列と直列
- [自前化とクラウド解禁の条件](docs/INDEPENDENCE.md) — 脱Ollama依存の段階計画と、クラウドを有効化する基準
- [段階的劣化](docs/DEGRADATION.md) — 遅くても動かすための設計（実行可能性プランナ・編成スタイル）
- [アーキテクチャ設計](docs/ARCHITECTURE.md) — 全体設計・Provider設計・保存データ設計・リスク

## 動作想定環境

Windows / Ryzen 5 / RTX 4060 (VRAM 8GB) / RAM 32GB

## 名称

`AdaptiveAIStudio` は開発時のプロジェクト名。製品名は分離し、後日決定する。
