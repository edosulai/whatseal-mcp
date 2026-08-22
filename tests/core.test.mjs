import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DraftStore,
  DEFAULT_RPC_TIMEOUT_MS,
  backendLifecycleCommands,
  buildReadinessGuidance,
  buildUnreadDigest,
  classifyRpcError,
  resolveAccountRecord,
  serializeChat,
  serializeMessage,
  truncateText,
} from '../lib/core.mjs';

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
  assert.equal(result.quoted, null);
  assert.equal('data' in result, false);
});

test('serializeMessage exposes quoted id and truncated body only', () => {
  const result = serializeMessage({
    id: { _serialized: 'reply-id', remote: '123@c.us' },
    body: 'reply',
    fromMe: true,
    from: 'me@c.us',
    timestamp: 200,
    type: 'chat',
    hasQuotedMsg: true,
    quoted: {
      id: { _serialized: 'quoted-id' },
      body: 'x'.repeat(500),
      type: 'chat',
      fromMe: false,
    },
  });
  assert.equal(result.hasQuotedMessage, true);
  assert.equal(result.quoted.id, 'quoted-id');
  assert.equal(result.quoted.fromMe, false);
  assert.ok(result.quoted.body.endsWith('…'));
  assert.ok(result.quoted.body.length <= 401);
});

test('unread digest is read-only, ranked, and cursor-aware', () => {
  const chats = [
    { id: 'old@c.us', name: 'Old', unreadCount: 1, timestamp: 10, lastMessage: { body: 'old' } },
    { id: 'zero@c.us', name: 'Zero', unreadCount: 0, timestamp: 50, lastMessage: { body: 'seen' } },
    { id: 'fresh@c.us', name: 'Fresh', unreadCount: 3, timestamp: 40, muted: true, lastMessage: { body: 'new' } },
    { id: 'mid@c.us', name: 'Mid', unreadCount: 2, timestamp: 20, lastMessage: { body: 'mid' } },
  ];
  const digest = buildUnreadDigest(chats, { limit: 2, now: () => '2026-01-01T00:00:00.000Z' });
  assert.equal(digest.markRead, false);
  assert.equal(digest.totalUnreadChats, 3);
  assert.equal(digest.totalUnreadMessages, 6);
  assert.equal(digest.truncated, true);
  assert.equal(digest.nextSince, 40);
  assert.deepEqual(digest.chats.map((chat) => chat.id), ['fresh@c.us', 'mid@c.us']);
  assert.equal(digest.chats[0].lastMessage.body, 'new');

  const countsOnly = buildUnreadDigest(chats, { includePreview: false, now: () => 't' });
  assert.equal('lastMessage' in countsOnly.chats[0], false);

  const incremental = buildUnreadDigest(chats, { since: 20, now: () => 't' });
  assert.deepEqual(incremental.chats.map((chat) => chat.id), ['fresh@c.us']);
});

test('quote-reply drafts bind the quoted message id separately from the Touch ID preview', () => {
  const store = new DraftStore();
  const payload = { quotedMessageId: 'quoted-1', text: 'Got it' };
  const draft = store.prepare({
    chatId: '123@c.us',
    chatName: 'Example',
    text: 'Reply to quoted-1\nGot it',
    action: 'send-reply',
    payload,
  });
  payload.text = 'mutated';
  draft.payload.quotedMessageId = 'wrong';
  const awaiting = store.beginApproval(draft.approvalId);
  assert.equal(awaiting.action, 'send-reply');
  assert.deepEqual(awaiting.payload, { quotedMessageId: 'quoted-1', text: 'Got it' });
  assert.notEqual(awaiting.text, awaiting.payload.text);
  assert.deepEqual(store.consumeApproved(draft.approvalId).payload, { quotedMessageId: 'quoted-1', text: 'Got it' });
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

test('resolveAccountRecord accepts id or alias and rejects unknown accounts', () => {
  const config = {
    default: 'alpha',
    accounts: [
      { id: 'alpha', alias: 'work', description: 'Work' },
      { id: 'beta', alias: 'personal', description: 'Personal' },
    ],
  };
  assert.equal(resolveAccountRecord(config, null).id, 'alpha');
  assert.equal(resolveAccountRecord(config, 'personal').id, 'beta');
  assert.throws(() => resolveAccountRecord(config, 'missing'), /Unknown account/);
});

test('default RPC timeout covers a cold Chrome wake', () => {
  assert.equal(DEFAULT_RPC_TIMEOUT_MS, 180_000);
});

test('readiness guidance for idle_cold tells agents to wait, not re-pair', () => {
  const guidance = buildReadinessGuidance({
    accountId: 'alpha',
    alias: 'work',
    phase: 'idle_cold',
    ready: false,
    projectRoot: '/tmp/whatseal-mcp',
  });
  assert.equal(guidance.ready, false);
  assert.equal(guidance.code, 'IDLE_COLD');
  assert.match(guidance.userMessage, /idle/i);
  assert.ok(guidance.agentNextSteps.some((step) => /wait_ready/i.test(step)));
  assert.ok(guidance.agentNextSteps.every((step) => !/start extra accounts|scan a new QR/i.test(step) || /Do not start extra accounts/i.test(step)));
});

test('readiness guidance for paused_by_lock asks to unlock', () => {
  const guidance = buildReadinessGuidance({
    accountId: 'alpha',
    alias: 'work',
    phase: 'paused_by_lock',
    ready: false,
    projectRoot: '/tmp/whatseal-mcp',
  });
  assert.equal(guidance.code, 'PAUSED_BY_LOCK');
  assert.match(guidance.userMessage, /paused_by_lock|locked/i);
});

test('readiness guidance for stopped backend is actionable', () => {
  const guidance = buildReadinessGuidance({
    accountId: 'alpha',
    alias: 'work',
    phase: 'stopped',
    ready: false,
    projectRoot: '/tmp/whatseal-mcp',
    code: 'BACKEND_UNAVAILABLE',
  });
  assert.equal(guidance.ready, false);
  assert.equal(guidance.code, 'BACKEND_UNAVAILABLE');
  assert.match(guidance.userMessage, /not running|stopped/i);
  assert.equal(guidance.commands.start, 'node cli.mjs start --account alpha');
  assert.ok(guidance.agentNextSteps.length > 0);
  assert.ok(guidance.agentNextSteps.some((step) => /cli\.mjs start --account alpha/.test(step)));
  assert.ok(guidance.agentNextSteps.some((step) => /never spawn/i.test(step)));
  assert.equal(backendLifecycleCommands('alpha', '/tmp/whatseal-mcp').start, 'node cli.mjs start --account alpha');
});

test('classifyRpcError maps not-ready and socket failures', () => {
  const notReady = classifyRpcError(
    new Error('WhatsApp backend is not ready (phase=pairing). Pair the linked device first.'),
    { accountId: 'alpha', alias: 'work', projectRoot: '/tmp/whatseal-mcp' },
  );
  assert.equal(notReady.code, 'NEEDS_PAIRING');
  assert.equal(notReady.ready, false);

  const unavailable = classifyRpcError(
    new Error('WhatsApp backend unavailable: connect ENOENT /tmp/control.sock'),
    { accountId: 'alpha', alias: 'work', projectRoot: '/tmp/whatseal-mcp', savedState: { phase: 'ready' } },
  );
  assert.equal(unavailable.code, 'BACKEND_UNAVAILABLE');
  assert.equal(unavailable.commands.start, 'node cli.mjs start --account alpha');
  assert.match(unavailable.commands.install, /install-launchagent\.sh install --account alpha/);

  const closedWhileCold = classifyRpcError(
    new Error('WhatsApp backend closed the connection without a response.'),
    { accountId: 'alpha', alias: 'work', projectRoot: '/tmp/whatseal-mcp', savedState: { phase: 'idle_cold' } },
  );
  assert.equal(closedWhileCold.code, 'IDLE_COLD');
  assert.ok(closedWhileCold.agentNextSteps.some((step) => /wait_ready/i.test(step)));

  const timeoutWhileCold = classifyRpcError(
    new Error('Backend request timed out after 180000 ms.'),
    { accountId: 'alpha', alias: 'work', projectRoot: '/tmp/whatseal-mcp', savedState: { phase: 'idle_cold' } },
  );
  assert.equal(timeoutWhileCold.code, 'IDLE_COLD');

  const lockPause = classifyRpcError(
    new Error('WhatsApp backend is paused_by_lock (screen locked or lid closed). Unlock/open lid to resume.'),
    { accountId: 'alpha', alias: 'work', projectRoot: '/tmp/whatseal-mcp' },
  );
  assert.equal(lockPause.code, 'PAUSED_BY_LOCK');
});
