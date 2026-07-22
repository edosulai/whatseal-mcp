import assert from 'node:assert/strict';
import test from 'node:test';

import { DraftStore, serializeChat, serializeMessage, truncateText } from '../lib/core.mjs';

test('truncateText enforces the requested maximum', () => {
  assert.equal(truncateText('abc', 3), 'abc');
  assert.equal(truncateText('abcd', 3), 'abc…');
});

test('serializeChat omits message previews unless explicitly requested', () => {
  const chat = {
    id: { _serialized: '123@c.us' },
    name: 'Example',
    unreadCount: 2,
    timestamp: 100,
    lastMessage: { body: 'hello', timestamp: 99, hasMedia: true, fromMe: false, type: 'image' },
  };
  const result = serializeChat(chat);
  assert.equal(result.id, '123@c.us');
  assert.equal(result.unreadCount, 2);
  assert.equal('lastMessage' in result, false);

  const withPreview = serializeChat(chat, { includeLastMessage: true });
  assert.equal(withPreview.lastMessage.hasMedia, true);
  assert.equal('media' in withPreview.lastMessage, false);
});

test('serializeMessage excludes raw message objects and media bytes', () => {
  const result = serializeMessage({
    id: { _serialized: 'message-id', remote: '123@c.us' },
    body: 'hello',
    hasMedia: true,
    fromMe: false,
    from: '123@c.us',
    timestamp: 100,
    type: 'image',
  });
  assert.equal(result.id, 'message-id');
  assert.equal(result.hasMedia, true);
  assert.equal('data' in result, false);
});

test('draft approval is exact, expiring, and single-use', () => {
  let now = 1000;
  const store = new DraftStore({ ttlMs: 500, now: () => now });
  const draft = store.prepare({ chatId: '123@c.us', chatName: 'Example', text: 'Hello' });

  assert.equal(store.beginApproval(draft.approvalId).text, 'Hello');
  assert.throws(() => store.beginApproval(draft.approvalId));
  assert.equal(store.consumeApproved(draft.approvalId).text, 'Hello');
  assert.throws(() => store.consumeApproved(draft.approvalId));

  const expiring = store.prepare({ chatId: '123@c.us', chatName: 'Example', text: 'Again' });
  now += 501;
  assert.throws(() => store.beginApproval(expiring.approvalId));
});

test('draft approval binds an immutable action payload', () => {
  const store = new DraftStore();
  const payload = { messageId: 'message-1', reaction: '✅' };
  const draft = store.prepare({
    chatId: '123@c.us',
    chatName: 'Example',
    text: 'React ✅ to message-1',
    action: 'react',
    payload,
  });

  payload.reaction = '❌';
  draft.payload.reaction = '❌';
  const awaiting = store.beginApproval(draft.approvalId);
  assert.equal(awaiting.action, 'react');
  assert.deepEqual(awaiting.payload, { messageId: 'message-1', reaction: '✅' });
  awaiting.payload.reaction = '❌';
  assert.deepEqual(store.consumeApproved(draft.approvalId).payload, { messageId: 'message-1', reaction: '✅' });
});

test('draft store bounds pending approvals', () => {
  const store = new DraftStore({ maximum: 1 });
  store.prepare({ chatId: '1@c.us', chatName: 'One', text: 'First' });
  assert.throws(() => store.prepare({ chatId: '2@c.us', chatName: 'Two', text: 'Second' }));
});