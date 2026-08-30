import type { ModelId } from '../model/ModelDescriptor.js';
import type { ConversationId, Message, MessageId, ProjectId } from './Message.js';

export interface ConversationInit {
  id: ConversationId;
  title: string;
  messages?: Message[];
  /** 明示固定。未指定なら Router に委ねる。 */
  pinnedModelId?: ModelId;
  projectId?: ProjectId;
}

export class Conversation {
  readonly id: ConversationId;
  title: string;
  pinnedModelId?: ModelId;
  projectId?: ProjectId;
  #messages: Message[];

  constructor(init: ConversationInit) {
    this.id = init.id;
    this.title = init.title;
    this.#messages = [...(init.messages ?? [])];
    if (init.pinnedModelId !== undefined) this.pinnedModelId = init.pinnedModelId;
    if (init.projectId !== undefined) this.projectId = init.projectId;
  }

  get messages(): readonly Message[] {
    return this.#messages;
  }

  append(m: Message): void {
    const last = this.#messages.at(-1);
    this.#messages.push(m.parentId === undefined && last ? { ...m, parentId: last.id } : m);
  }

  /** fromMessageId までを引き継いだ新しい会話を作る。元の会話は変更しない。 */
  fork(newId: ConversationId, fromMessageId: MessageId): Conversation {
    const idx = this.#messages.findIndex((m) => m.id === fromMessageId);
    if (idx < 0) throw new Error(`message not found in conversation: ${fromMessageId}`);
    return new Conversation({
      id: newId,
      title: this.title,
      messages: this.#messages.slice(0, idx + 1).map((m) => ({ ...m })),
      ...(this.pinnedModelId !== undefined ? { pinnedModelId: this.pinnedModelId } : {}),
      ...(this.projectId !== undefined ? { projectId: this.projectId } : {}),
    });
  }
}
