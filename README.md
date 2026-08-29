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

### 1. ローカルLLMを起動する

```
ollama serve
ollama pull qwen2.5-coder:7b
```

RTX 4060 (VRAM 8GB) なら 7B の Q4 量子化が常用圏。14B以上は一部CPUに載る。

### 2. 設定する（任意）

```
cp aas.config.example.json aas.config.json
```

省略した場合は `ollama:qwen2.5-coder:7b` を既定として起動する。
`candidates` は先頭から順に試され、利用制限や障害で使えなければ次へ自動で切り替わる。

### 3. 起動する

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

### コマンド

| コマンド | 説明 |
|---|---|
| `/models` | 利用可能なモデル一覧 |
| `/model <id>` | 使用モデルを固定 |
| `/auto` | 固定を解除し設定の候補順に戻す |
| `/health` | 各Providerの到達性と冷却状態 |
| `/new` | 履歴を破棄 |
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

| Phase | 状態 |
|---|---|
| P1 ローカル実行 | チャット・モデル一覧・設定は動作。モデルDL/VRAM解放は未実装 |
| P2 Provider層 | 契約・正規化エラー・Router・フォールバック・冷却まで完了。クラウドアダプタは未実装 |
| P3 以降 | 未着手 |

現時点の実装は `openai-compatible` アダプタ1本。
Ollama / LM Studio / vLLM / llama.cpp-server は `baseUrl` の設定だけで接続できる。

---

## ドキュメント

- [アーキテクチャ設計](docs/ARCHITECTURE.md) — 全体設計・Provider設計・保存データ設計・Phase計画・リスク

## 動作想定環境

Windows / Ryzen 5 / RTX 4060 (VRAM 8GB) / RAM 32GB

## 名称

`AdaptiveAIStudio` は開発時のプロジェクト名。製品名は分離し、後日決定する。
