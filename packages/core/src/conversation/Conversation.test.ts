import { describe, expect, it } from 'vitest';
import { Conversation } from './Conversation.js';
import type { Message } from './Message.js';
import { textBlock } from './Message.js';

const msg = (id: string, role: Message['role'], text: string): Message => ({
  id,
  role,
  content: [textBlock(text)],
  meta: { createdAt: '2026-01-01T00:00:00.000Z' },
});

describe('Conversation', () => {
  it('append は直前のメッセージを親として連結する', () => {
    const c = new Conversation({ id: 'c1', title: 't' });
    c.append(msg('m1', 'user', 'a'));
    c.append(msg('m2', 'assistant', 'b'));
    expect(c.messages.map((m) => m.parentId)).toEqual([undefined, 'm1']);
  });

  it('fork は指定メッセージまでを複製し、元の会話を変更しない', () => {
    const c = new Conversation({ id: 'c1', title: 't', pinnedModelId: 'anthropic:x' });
    c.append(msg('m1', 'user', 'a'));
    c.append(msg('m2', 'assistant', 'b'));
    c.append(msg('m3', 'user', 'c'));

    const forked = c.fork('c2', 'm2');
    forked.append(msg('m4', 'assistant', 'd'));

    expect(forked.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm4']);
    expect(c.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(forked.pinnedModelId).toBe('anthropic:x');
  });

  it('存在しないメッセージからの fork は失敗する', () => {
    const c = new Conversation({ id: 'c1', title: 't' });
    expect(() => c.fork('c2', 'nope')).toThrow();
  });
});
