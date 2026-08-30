import type { ModelId, ProviderId } from '../model/ModelDescriptor.js';

export type MessageId = string;
export type ConversationId = string;
export type ProjectId = string;

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'toolCall'; id: string; name: string; args: unknown }
  | { type: 'toolResult'; callId: string; content: string; isError?: boolean };

export interface MessageMeta {
  /** どのモデルが答えたか。フォールバックを可視化するための必須記録 (R6)。 */
  modelId?: ModelId;
  providerId?: ProviderId;
  usage?: { inputTokens: number; outputTokens: number };
  latencyMs?: number;
  /** フォールバック発生の証跡。 */
  fallbackFrom?: ModelId;
  createdAt: string;
}

export interface Message {
  id: MessageId;
  /** 分岐 (fork) を表現するための親参照。 */
  parentId?: MessageId;
  role: Role;
  content: ContentBlock[];
  meta: MessageMeta;
}

export const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

export function messageText(m: Message): string {
  return m.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
