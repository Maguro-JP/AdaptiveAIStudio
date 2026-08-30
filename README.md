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

## ドキュメント

- [アーキテクチャ設計](docs/ARCHITECTURE.md) — 全体設計・Provider設計・保存データ設計・Phase計画・リスク
- [ADR](docs/adr/) — 設計判断の記録

## 現在の実装状況

Phase1〜2 の中核 (Provider契約・フォールバック・ルーティング) を実装済み。
UI・永続化・Core Daemon は未着手。

| パッケージ | 内容 |
|---|---|
| `packages/core` | Domain。外部I/Oゼロ。`ModelDescriptor` / `Conversation` / Ports |
| `packages/providers/contract` | `ChatProvider` と正規化エラー `ProviderError` |
| `packages/providers/openai-compatible` | Ollama / LM Studio / vLLM を1本で吸収するアダプタ |
| `packages/application` | `ProviderRegistry` / `ModelRouter` / `FallbackPolicy` / `ChatOrchestrator` |
| `tests/contract` | 全Provider共通の適合テスト |

## 開発

```bash
pnpm install
pnpm test         # 単体テスト + Provider適合テスト
pnpm typecheck
```

新しい Provider を追加するときは `tests/contract/chatProviderContract.ts` の
適合テストを通すことが条件となる。

## 動作想定環境

Windows / Ryzen 5 / RTX 4060 (VRAM 8GB) / RAM 32GB

## 名称

`AdaptiveAIStudio` は開発時のプロジェクト名。製品名は分離し、後日決定する。
