import type { Conversation } from '../conversation/Conversation.js';
import type { ConversationId, ProjectId } from '../conversation/Message.js';
import type { ModelDescriptor, ModelId } from '../model/ModelDescriptor.js';

export interface ConversationSummary {
  id: ConversationId;
  title: string;
  updatedAt: string;
}

export interface SearchQuery {
  text?: string;
  projectId?: ProjectId;
  limit?: number;
}

export interface ConversationRepository {
  save(c: Conversation): Promise<void>;
  findById(id: ConversationId): Promise<Conversation | null>;
  search(q: SearchQuery): Promise<ConversationSummary[]>;
}

export type MemoryKind = 'naming' | 'rule' | 'design' | 'db' | 'knowledge';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  title: string;
  /** 正本はファイル。DB は索引に過ぎない。 */
  filePath: string;
  scope: 'always' | 'on_demand';
  body: string;
}

export interface RetrievalQuery {
  text: string;
  limit?: number;
}

export interface ProjectMemoryStore {
  load(projectId: ProjectId): Promise<MemoryEntry[]>;
  upsert(projectId: ProjectId, entry: MemoryEntry): Promise<void>;
  retrieve(projectId: ProjectId, ctx: RetrievalQuery): Promise<MemoryEntry[]>;
}

/** APIキーは必ずここ経由。DB にも .env にも置かない (R8)。 */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface Progress {
  completedBytes: number;
  totalBytes?: number;
}

/** Ollama / llama.cpp を抽象化する。VRAM 8GB では unload が必須機能 (R2)。 */
export interface LocalRuntime {
  listInstalled(): Promise<ModelDescriptor[]>;
  pull(ref: string, onProgress: (p: Progress) => void): Promise<void>;
  ensureLoaded(id: ModelId): Promise<void>;
  unload(id: ModelId): Promise<void>;
}
