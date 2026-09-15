# AdaptiveAIStudio アーキテクチャ設計書

版: 0.1 (初版 / 設計提案)

---

## 0. 前提と設計制約

| 項目 | 内容 |
|---|---|
| 目的 | 利用制限・障害・サービス終了で開発が停止しないこと |
| 非目的 | 完全無料化 / Claude代替の実装 / 特定モデルの最適化 |
| 実行環境 | Windows / Ryzen 5 / RTX 4060 (VRAM 8GB) / RAM 32GB |
| 利用者 | 個人1名(将来的に自分の複数マシン) |
| 寿命想定 | 5年以上。モデル・SDK・サービスは全て入れ替わる前提 |

**最大の制約はVRAM 8GB。** これが Phase1 のモデル選定と量子化方針を規定する。
ローカルで常用できるのは 7B〜14B の 4bit量子化(Q4_K_M)まで。
32B級はオフロードで動くが実用速度に届かないため、常用対象から外す。

### 設計上の絶対ルール

1. UI層はモデル名・SDK・HTTPクライアントを一切知らない。
2. Provider実装はUI層の型・状態を一切知らない。
3. Core(ドメイン)は外部I/Oを持たない。すべてPort(interface)経由。
4. 依存の向きは常に **外→内**(UI → Application → Domain)。逆流禁止。

---

## 1. アーキテクチャ

### 1.1 レイヤ構成

```
┌─────────────────────────────────────────────┐
│ Presentation Layer (UI)                     │
│  Chat / History / Settings / Model Manager  │
└───────────────────┬─────────────────────────┘
                    │ ViewModel / Command のみ
┌───────────────────▼─────────────────────────┐
│ Application Layer (ユースケース)             │
│  SendMessage / SwitchModel / ReviewCode ...  │
│  Router · FallbackPolicy · Orchestrator      │
└───────────────────┬─────────────────────────┘
                    │ Port (interface)
┌───────────────────▼─────────────────────────┐
│ Domain Layer (Core)                         │
│  Conversation / Message / ModelDescriptor    │
│  PromptTemplate / ProjectMemory / Policy     │
│  ※ 外部依存ゼロ・純粋ロジックのみ            │
└───────────────────┬─────────────────────────┘
                    │ Port 実装
┌───────────────────▼─────────────────────────┐
│ Infrastructure Layer                        │
│  Provider Adapters │ Storage │ Runtime      │
│  Anthropic/OpenAI/ │ SQLite  │ llama.cpp    │
│  Gemini/OpenAI互換 │ FS      │ Ollama/vLLM  │
└─────────────────────────────────────────────┘
```

### 1.2 実行時トポロジ

UIプロセスとAI実行プロセスを分離する。これが「止まらない」ための構造的な要。

```
┌──────────────┐   HTTP/WS(localhost)   ┌────────────────────┐
│ Desktop UI   │◄──────────────────────►│ AAS Core Daemon    │
│ (Tauri+React)│   JSON / SSE stream    │ (ローカル常駐)      │
└──────────────┘                        └─────────┬──────────┘
                                                  │
                          ┌───────────────────────┼──────────────────────┐
                          ▼                       ▼                      ▼
                   ┌────────────┐         ┌─────────────┐        ┌─────────────┐
                   │ Local      │         │ Cloud       │        │ Storage     │
                   │ Runtime    │         │ Providers   │        │ SQLite      │
                   │ llama.cpp/ │         │ Claude/GPT/ │        │ + files     │
                   │ Ollama     │         │ Gemini      │        │             │
                   └────────────┘         └─────────────┘        └─────────────┘
```

分離する理由:
- UIをクラッシュ・再起動してもモデルのロード状態と実行中ジョブが生き残る
- 同じCoreをCLI / エディタ拡張 / 別UIから再利用できる(Phase7の前提)
- UIフレームワークを将来まるごと差し替えても資産が残る

### 1.3 リクエストの流れ(フォールバック込み)

```
UI: sendMessage(conversationId, text)
      │
      ▼
Application: SendMessageUseCase
      │  1. ProjectMemory + 履歴 から Context組み立て
      │  2. Router.resolve(task, policy) → 候補Provider列 [primary, fallback...]
      ▼
Router → Provider#1 (Claude)
      │      ├─ 成功 → stream を UI へ中継
      │      └─ RateLimited / Unavailable / Timeout
      ▼
FallbackPolicy: 「切替可能」と判定
      │  ・UIに切替を通知(どのモデルに落ちたかを必ず可視化)
      │  ・同一Context を再構築(モデル差を吸収して整形)
      ▼
Router → Provider#2 (Local Qwen)
      │      └─ 成功 → stream 継続
      ▼
Storage: Message を確定保存(使用モデル・トークン数・所要時間を併記)
```

**重要:** フォールバックは「暗黙に起きて気づかない」が最悪。
必ずメッセージ単位で使用モデルを記録し、UIにバッジ表示する。

---

## 2. ディレクトリ構成

pnpm workspace によるモノレポ。

```
AdaptiveAIStudio/
├── apps/
│   ├── desktop/                  # Tauri + React (Presentation)
│   │   ├── src/
│   │   │   ├── features/
│   │   │   │   ├── chat/
│   │   │   │   ├── history/
│   │   │   │   ├── models/       # モデル管理画面
│   │   │   │   ├── prompts/
│   │   │   │   └── settings/
│   │   │   ├── shared/ui/        # デザインシステム
│   │   │   └── api/              # Core Daemon クライアント (唯一の通信点)
│   │   └── src-tauri/            # Rust シェル(常駐・自動起動・トレイ)
│   ├── core-daemon/              # ローカルHTTP/WSサーバ (Application公開)
│   └── cli/                      # aas コマンド (Phase4以降)
│
├── packages/
│   ├── core/                     # Domain: 外部依存ゼロ
│   │   ├── conversation/
│   │   ├── model/                # ModelDescriptor / Capability
│   │   ├── memory/               # ProjectMemory
│   │   ├── prompt/
│   │   ├── policy/               # Routing / Fallback ルール
│   │   └── ports/                # ★ interface 定義の集約点
│   ├── application/              # UseCase / Router / Orchestrator
│   ├── providers/
│   │   ├── contract/             # Provider interface + 共通エラー型
│   │   ├── anthropic/
│   │   ├── openai/
│   │   ├── google/
│   │   ├── openai-compatible/    # Ollama / LM Studio / vLLM / llama.cpp
│   │   └── registry/             # 検出・登録・ヘルスチェック
│   ├── runtime/                  # ローカル推論プロセス管理
│   │   ├── ollama/
│   │   └── llamacpp/
│   ├── storage/
│   │   ├── sqlite/               # 実装
│   │   └── migrations/
│   ├── tools/                    # Phase6 Agent ツール (fs/search/test)
│   └── shared/                   # 型・Result・logger・トークン計算
│
├── config/
│   ├── models.default.yaml       # モデルカタログ(同梱の初期値)
│   └── policy.default.yaml       # ルーティング/フォールバック既定値
│
├── docs/
│   ├── ARCHITECTURE.md
│   ├── adr/                      # 設計判断の記録
│   └── providers/                # Provider追加手順
└── tests/
    └── contract/                 # ★ 全Provider共通の適合テスト
```

`packages/core/ports/` と `packages/providers/contract/` が本プロジェクトの心臓部。
ここを安定させれば、外側は何度でも作り直せる。

---

## 3. クラス設計

### 3.1 Domain

```ts
// packages/core/model/ModelDescriptor.ts
type ModelId = string;          // "anthropic:claude-opus-5" / "local:qwen3-14b"
type ProviderId = string;       // "anthropic" / "ollama"

interface ModelDescriptor {
  id: ModelId;
  providerId: ProviderId;
  displayName: string;
  family: string;               // "claude" | "qwen" | "llama" ...
  capabilities: ModelCapabilities;
  limits: ModelLimits;
  cost?: CostProfile;           // ローカルは undefined
  locality: 'local' | 'cloud';
}

interface ModelCapabilities {
  streaming: boolean;
  toolUse: boolean;
  vision: boolean;
  jsonMode: boolean;
  systemPrompt: boolean;        // 単独systemを持てないモデルの吸収用
}

interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
  estimatedVramGb?: number;     // ローカル選定に必須
}
```

```ts
// packages/core/conversation/
class Conversation {
  readonly id: ConversationId;
  title: string;
  messages: Message[];
  pinnedModelId?: ModelId;      // 明示固定。未指定ならRouterに委ねる
  projectId?: ProjectId;

  append(m: Message): void;
  fork(fromMessageId: MessageId): Conversation;   // 分岐は履歴の必須機能
}

interface Message {
  id: MessageId;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ContentBlock[];      // text / image / toolCall / toolResult
  meta: MessageMeta;
}

interface MessageMeta {
  modelId?: ModelId;            // ★ どのモデルが答えたか(必須記録)
  providerId?: ProviderId;
  usage?: { inputTokens: number; outputTokens: number };
  latencyMs?: number;
  fallbackFrom?: ModelId;       // フォールバック発生の証跡
  createdAt: string;
}
```

### 3.2 Ports (Domainが要求するinterface)

```ts
// packages/core/ports/
interface ChatProvider { /* §4 参照 */ }

interface ConversationRepository {
  save(c: Conversation): Promise<void>;
  findById(id: ConversationId): Promise<Conversation | null>;
  search(q: SearchQuery): Promise<ConversationSummary[]>;
}

interface ProjectMemoryStore {
  load(projectId: ProjectId): Promise<MemoryEntry[]>;
  upsert(projectId: ProjectId, entry: MemoryEntry): Promise<void>;
  retrieve(projectId: ProjectId, ctx: RetrievalQuery): Promise<MemoryEntry[]>;
}

interface SecretStore {                 // APIキーは必ずここ経由。DBに置かない
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

interface LocalRuntime {                // Ollama / llama.cpp を抽象化
  listInstalled(): Promise<ModelDescriptor[]>;
  pull(ref: string, onProgress: (p: Progress) => void): Promise<void>;
  ensureLoaded(id: ModelId): Promise<void>;
  unload(id: ModelId): Promise<void>;   // VRAM 8GB では解放が必須機能
}
```

### 3.3 Application

```ts
class ProviderRegistry {
  register(p: ChatProvider): void;
  get(id: ProviderId): ChatProvider;
  listAvailableModels(): Promise<ModelDescriptor[]>;   // health込み
}

class ModelRouter {
  // タスク種別 + ポリシー + 現在の可用性 から候補列を返す
  resolve(task: TaskKind, policy: RoutingPolicy): ModelId[];
}

class FallbackPolicy {
  shouldFallback(e: ProviderError, attempt: number): boolean;
  nextDelayMs(attempt: number): number;                // 指数バックオフ
}

class ChatOrchestrator {
  // Router → Provider実行 → 失敗判定 → 次候補 → 保存 までを統括
  async *run(input: ChatInput): AsyncIterable<ChatEvent>;
}

class ContextBuilder {
  // 履歴 + ProjectMemory + テンプレを、対象モデルの制約に合わせて構築
  build(conv: Conversation, target: ModelDescriptor): ProviderRequest;
  // contextWindow超過時は 古い履歴の要約圧縮 → 直近は原文保持
}
```

`ContextBuilder` がモデル差(context長・system有無・tool形式)の吸収点。
ここを一箇所に閉じ込めることで、モデル交換のコストが定数になる。

---

## 4. Provider設計

### 4.1 契約(これが本プロジェクトで最も重要な境界)

```ts
// packages/providers/contract/ChatProvider.ts
interface ChatProvider {
  readonly id: ProviderId;
  readonly locality: 'local' | 'cloud';

  listModels(): Promise<ModelDescriptor[]>;
  health(): Promise<HealthStatus>;         // 到達性 + 制限状態

  chat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>;
}

interface ProviderRequest {
  modelId: ModelId;
  system?: string;
  messages: ProviderMessage[];             // 正規化済み中立形式
  tools?: ToolSchema[];
  params: { temperature?: number; maxTokens?: number; topP?: number };
}

type ProviderChunk =
  | { type: 'text';       delta: string }
  | { type: 'toolCall';   id: string; name: string; args: unknown }
  | { type: 'usage';      inputTokens: number; outputTokens: number }
  | { type: 'done';       finishReason: FinishReason };
```

### 4.2 正規化エラー(フォールバック判断の唯一の根拠)

各SDK固有の例外は、必ずアダプタ内でこの型へ変換する。
Application層はHTTPステータスもSDK例外も見ない。

```ts
type ProviderErrorKind =
  | 'rate_limited'        // ★ 本プロジェクトの主目的。即フォールバック
  | 'quota_exhausted'     // ★ 同上。当該Providerを一定時間クールダウン
  | 'unavailable'         // 5xx / ネットワーク断 → リトライ後フォールバック
  | 'timeout'             // リトライ後フォールバック
  | 'context_too_long'    // 圧縮して再試行 → 駄目なら長context機へ
  | 'auth'                // フォールバック(キー不備は自動復旧しない)
  | 'invalid_request'     // 即失敗。フォールバックしない(バグ)
  | 'content_filtered'    // 即失敗。別モデルで回避を試みない(方針)
  | 'canceled';

class ProviderError extends Error {
  kind: ProviderErrorKind;
  providerId: ProviderId;
  retryAfterMs?: number;
  cause?: unknown;
}
```

| kind | 再試行 | フォールバック | Provider冷却 |
|---|---|---|---|
| rate_limited | retryAfter尊重で1回 | する | 60s |
| quota_exhausted | しない | する | 30min |
| unavailable / timeout | 2回(指数) | する | 5min |
| context_too_long | 圧縮して1回 | 長context機のみ | しない |
| auth | しない | する | 手動解除まで |
| invalid_request / content_filtered | しない | **しない** | しない |

### 4.3 アダプタ実装方針

| Provider | 実装 | 備考 |
|---|---|---|
| `anthropic` | 公式SDK | Claude。Phase2 |
| `openai` | 公式SDK | GPT系 |
| `google` | 公式SDK | Gemini |
| `openai-compatible` | fetch のみ | **baseURL可変**。Ollama / LM Studio / vLLM / llama.cpp-server / 将来の未知サービスを全部これ1本で吸収 |

`openai-compatible` を持つことが「サービス終了に依存しない」ことの実体的な担保。
新サービスの多くはOpenAI互換APIを出すため、設定にURLを書くだけで即日つながる。

### 4.4 Provider適合テスト(必須)

`tests/contract/` に全Provider共通のテストスイートを置き、
新規Providerはこれをパスすることを追加条件とする。

- ストリームが順序通り届き、最後に必ず `done` が来る
- `AbortSignal` で確実に中断される(リークしない)
- 429応答が `rate_limited` に正規化される
- context超過が `context_too_long` に正規化される
- `usage` が取得できない場合も推定値で埋まる

これがあるとProviderの追加が「作業」に落ちる。無いと毎回「調査」になる。

---

## 5. 保存データ設計

### 5.1 配置

```
%APPDATA%/AdaptiveAIStudio/
├── aas.db                 # SQLite: 会話・メッセージ・メモリ・設定
├── secrets/               # OS資格情報ストア経由。平文APIキーは置かない
├── models/                # GGUF等(巨大。バックアップ対象外)
├── prompts/               # *.md — テキストファイルで持つ(Git管理可)
├── projects/<id>/memory/  # *.md — 同上
└── logs/
```

**方針:** 構造化データ=SQLite、人間が読み書きするもの=Markdownファイル。
プロンプトとProject MemoryをDBに閉じ込めるとGit管理も手編集もできなくなる。
DBには「ファイルの索引と埋め込み」だけを持たせ、正本はファイルとする。

### 5.2 スキーマ

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  pinned_model_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES messages(id),   -- 分岐(fork)を表現
  role TEXT NOT NULL,
  content TEXT NOT NULL,                    -- ContentBlock[] の JSON
  model_id TEXT,                            -- どのモデルが答えたか
  provider_id TEXT,
  fallback_from TEXT,                       -- 切替の証跡
  input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);

-- 全文検索(履歴検索の実体)
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content, content='messages', content_rowid='rowid', tokenize='trigram'
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT,                           -- ローカルリポジトリの位置
  created_at TEXT NOT NULL
);

-- Project Memory: 正本はファイル、ここは索引
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,        -- naming | rule | design | db | knowledge
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,   -- projects/<id>/memory/xxx.md
  content_hash TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'always',  -- always | on_demand
  updated_at TEXT NOT NULL
);

CREATE TABLE memory_embeddings (           -- Phase5後半。無くても動く設計
  entry_id TEXT PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
  vector BLOB NOT NULL,
  dim INTEGER NOT NULL,
  model TEXT NOT NULL                      -- 埋め込みモデルも交換可能に
);

CREATE TABLE model_catalog (               -- 実測値の蓄積
  model_id TEXT PRIMARY KEY,
  descriptor TEXT NOT NULL,                -- ModelDescriptor JSON
  measured_tps REAL,                       -- 自環境での実測 tokens/sec
  last_health TEXT, last_checked_at TEXT
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
```

### 5.3 エクスポート

会話・プロンプト・メモリは JSON + Markdown へ全量エクスポート可能とする。
**このアプリ自体が将来捨てられることを前提に設計する。**
自作ツールへのロックインは、サービスへのロックインと同じ問題を再生産する。

---

## 6. MVP設計

「利用制限で開発が止まる」を最短で解消する範囲に絞る。

### MVPに入れるもの

1. ローカルモデル1つでのストリーミングチャット(Ollama経由 / Qwen2.5-Coder-7B Q4)
2. Claudeプロバイダ
3. **手動でのモデル切替**(ヘッダのセレクタ)
4. 自動フォールバック(`rate_limited` / `quota_exhausted` / `unavailable` のみ)
5. 会話のSQLite保存と一覧
6. APIキー設定(OS資格情報ストア)
7. 使用モデルのメッセージ単位表示

### MVPに入れないもの

Agent / ツール実行 / RAG / 埋め込み / 検索 / プロンプトライブラリ /
コードレビュー機能 / マルチプロジェクト / 同期。

### MVPの完了条件(これが満たせれば目的は達成)

> Claudeで作業中に利用制限に達したとき、**手を止めずに**ローカルモデルで
> 会話を継続でき、どのモデルが応答したかが後から履歴で判別できる。

MVPの目標規模は 2〜3週間(平日夜+週末)。ここを膨らませない。

---

## 7. Phase別実装計画

| Phase | 内容 | 主な成果物 | 完了条件 |
|---|---|---|---|
| **P1** ローカル実行 | Runtime抽象 / モデルDL・ロード・解放 / 設定 / チャット | `runtime`, `providers/openai-compatible`, desktop最小UI | ローカルモデルとストリーミング対話でき、VRAMを手動解放できる |
| **P2** Provider層 | contract確定 / anthropic・openai・google / Registry / Router / Fallback / 適合テスト | `providers/*`, `application/router` | 制限到達時に自動でローカルへ落ち、切替がUIに表示される |
| **P3** Chat UI | 履歴・全文検索・分岐・プロンプト保存・モデル切替 | `storage/sqlite`, FTS5, features/history | 過去会話を検索し、途中から分岐して別モデルで続行できる |
| **P4** 開発支援 | コード生成/レビュー/リファクタ/テスト生成/ドキュメント。タスク種別ごとの既定モデル | タスクテンプレ, `cli` | タスクを選ぶと適切なモデル・プロンプトが自動適用される |
| **P5** Project Memory | 命名規則・開発ルール・設計方針・DBルールの保持と自動注入。埋め込み検索 | `core/memory`, embeddings | 新規会話で毎回ルールを貼り直す必要がなくなる |
| **P6** Agent | ファイル検索/編集/テスト実行。**必ず差分プレビューと承認を挟む** | `tools/*`, 承認UI | 小規模な修正をレビュー付きで自動適用できる |
| **P7** 個人環境 | 独自コマンド・ワークフロー・テンプレート、エディタ連携 | ワークフローDSL | 自分の定型作業がコマンド1つで走る |

各Phaseの間に「1週間そのまま日常使用する」期間を挟む。
使わずに次を作ると、使わない機能の山になる。

---

## 8. 技術選定理由

| 領域 | 選定 | 理由 | 却下案 |
|---|---|---|---|
| 言語 | TypeScript | Provider SDKが最も揃い、UI/Core/CLIを1言語で書ける。個人開発では言語数=維持コスト | Python: UIとバイナリ配布が弱い / Rust全面: 開発速度が出ない |
| デスクトップ | Tauri v2 | メモリ数十MB(Electronは数百MB)。32GB環境でモデルにRAMを譲れる。自動更新・トレイ常駐あり | Electron: 常駐に対して重い |
| UI | React + TypeScript | 情報量が最大。UI層は将来の使い捨て前提なので、独自性より入手性を優先 | Svelte/Solid: 良いが資料量で劣る |
| Core配置 | 独立デーモン | UI再起動でモデルロード状態を失わない。CLI/拡張から再利用可 | UI内蔵: Phase7で必ず行き詰まる |
| ローカル推論 | Ollama(既定) + llama.cpp(直) | OllamaはWindowsでのモデル管理が容易。llama.cpp直は細かいVRAM制御用。**両方をLocalRuntime裏に置き、どちらにも依存しない** | どちらか一方への固定 |
| ローカル接続 | OpenAI互換HTTP | 事実上の共通語。ネイティブAPIに寄せると乗り換えのたびに書き直しになる | Ollamaネイティブ API |
| 保存 | SQLite + FTS5 | 単一ファイル・バックアップ容易・全文検索内蔵・サーバ不要 | PostgreSQL: 個人用途に過剰 / JSONファイル: 検索が破綻 |
| ベクトル | sqlite-vec(P5から) | SQLiteに同居。別サービスを立てない | Qdrant/Chroma: 常駐プロセスが増える |
| キー管理 | OS資格情報ストア | 平文保存の回避。Windows Credential Manager | .env: 事故る |
| 検証 | Zod | Provider応答は信用しない。境界で必ず検証 | 手書き型ガード |

**初期ローカルモデル候補(VRAM 8GB前提):**

| 用途 | モデル | 量子化 | 概算VRAM |
|---|---|---|---|
| コード主力 | Qwen2.5-Coder-7B-Instruct | Q4_K_M | ~5.5GB |
| 汎用/日本語 | Qwen2.5-14B-Instruct | Q4_K_M | ~9GB(一部CPU) |
| 軽量・高速 | Gemma-2-9B / Llama-3.1-8B | Q4_K_M | ~6GB |

いずれも `config/models.default.yaml` の記述に過ぎず、コードには一切現れない。

---

## 9. リスク

| # | リスク | 影響 | 対策 |
|---|---|---|---|
| R1 | **ローカルモデルの品質差** — Claudeの感覚で使うと失望し、結局Claudeだけ使う | 目的未達 | タスク種別でモデルを割当てる(定型・補完はローカル、設計・難問はクラウド)。「同等品質」を期待させないUI文言にする |
| R2 | **VRAM 8GBの壁** — 大きいモデルが載らない | 用途制限 | 明示的なロード/アンロード機能を最初から入れる。`estimatedVramGb` で載らないモデルはUIで警告 |
| R3 | **Provider契約の設計ミス** — 後から全アダプタ書き直し | 大 | P2で契約を確定させ、契約テストを先に書く。契約変更はADRを必須にする |
| R4 | **抽象化の過剰** — 使ってもいないモデルのために層を積む | 開発停止 | 「実在する2種以上のProviderで必要になるまで抽象化しない」を規約とする |
| R5 | **Phase肥大化** — 個人開発でP7まで到達せず放棄 | 最大リスク | 各Phaseを単体で有用な状態で終える。MVP後は常に自分で毎日使う |
| R6 | フォールバックの暗黙発生で品質劣化に気づかない | 信頼性 | メッセージ単位でモデルを記録・表示。フォールバック時はトースト通知 |
| R7 | SDK破壊的変更 / 提供終了 | 中 | アダプタ内に封じ込め済み。最悪 `openai-compatible` + 手書きfetchへ退避 |
| R8 | APIキー漏洩 | 大 | OS資格情報ストア。ログ・エクスポート・エラー本文からのマスキングを共通化 |
| R9 | Agent(P6)の破壊的操作 | 大 | 差分プレビューと明示承認を必須。書込ルートをプロジェクト配下に制限。Git未コミット時は警告 |
| R10 | 会話データの肥大化 | 中 | アーカイブ + 古い会話の要約圧縮。エクスポート後の削除導線 |

R4とR5が実際に最も高い。「モデル依存禁止」の原則は、
**汎用フレームワークを作る許可ではない**ことを繰り返し確認する。

---

## 10. 将来的な拡張設計

### 10.1 拡張点(既に構造として用意されているもの)

| 拡張 | 追加作業 |
|---|---|
| 新モデル追加(既存Provider) | `config/models.default.yaml` に1エントリ。コード変更なし |
| 新サービス(OpenAI互換) | 設定にbaseURL追加。コード変更なし |
| 新サービス(独自API) | `packages/providers/<name>/` を1つ追加し契約テストを通す |
| 新ローカルランタイム | `LocalRuntime` 実装を1つ追加 |
| 新UI(CLI/エディタ拡張) | Core Daemon のAPIを叩くだけ |

### 10.2 中期構想

- **モデルのアンサンブル** — 生成をローカル、批評をクラウドに分担する二段構成。
  `ChatOrchestrator` に多段パイプラインを入れる余地を残してある。
- **自動ルーティングの学習** — `model_catalog.measured_tps` と満足度フィードバックを蓄積し、
  タスク種別ごとの既定モデルを自動調整する。
- **マルチマシン** — 別PCのCore Daemonを `openai-compatible` なリモートProviderとして登録。
  将来強力なGPU機を用意した場合、ノートPCから同じUIで使える。
- **MCP対応** — P6のツール層をMCPクライアントとして実装すれば、既存ツール資産をそのまま使える。
  ツール層も「特定エコシステム依存禁止」の対象とし、内部抽象の背後に置く。

### 10.3 やらないと決めること

- 複数ユーザー / 権限管理 / SaaS化
- モデルの自前学習・ファインチューニング基盤
- 汎用プラグインマーケット

これらは「自分専用の開発環境」という目的を薄める。
必要になった時点で、その時の技術で作り直す方が速い。

---

## 付録: 最初に着手すべき3つ

1. `packages/providers/contract/` — `ChatProvider` と `ProviderError` を書く
2. `tests/contract/` — 契約テストを先に書く
3. `packages/providers/openai-compatible/` — Ollamaに繋いで契約テストを通す

この3つが通った時点で、本プロジェクトの設計上の賭けはほぼ検証済みになる。
