import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateBotAudioLifecycle,
  evaluateAutoAcceptCallPolicy,
  isLidJid,
  normalizeCallerPhone,
  parseAutoAcceptCallers,
  phoneFromPnJid,
  serializePeerJid,
} from '../lib/call-policy.mjs';

test('normalizes E.164 display punctuation without accepting arbitrary text', () => {
  assert.equal(normalizeCallerPhone('+1 202-555-0101'), '12025550101');
  assert.equal(normalizeCallerPhone('(1) 202.555-0102'), '12025550102');
  assert.equal(normalizeCallerPhone('call +1 202 555 0101'), null);
  assert.equal(normalizeCallerPhone('+0123456789'), null);
  assert.equal(normalizeCallerPhone('1234567'), null);
});

test('parses and deduplicates caller allowlist while failing invalid config closed', () => {
  assert.deepEqual(parseAutoAcceptCallers(''), { valid: true, callers: [], invalidEntries: [] });
  assert.deepEqual(
    parseAutoAcceptCallers('+1 202-555-0101,12025550101,+1 202-555-0102'),
    { valid: true, callers: ['12025550101', '12025550102'], invalidEntries: [] },
  );
  const malformed = parseAutoAcceptCallers('12025550101,not-a-phone');
  assert.equal(malformed.valid, false);
  assert.deepEqual(malformed.callers, ['12025550101']);
});

test('serializes peer IDs and distinguishes phone and LID namespaces', () => {
  assert.equal(serializePeerJid({ _serialized: '12025550101@c.us' }), '12025550101@c.us');
  assert.equal(serializePeerJid({ user: '12345', server: 'lid' }), '12345@lid');
  assert.equal(phoneFromPnJid('12025550101@c.us'), '12025550101');
  assert.equal(phoneFromPnJid('12025550101@s.whatsapp.net'), '12025550101');
  assert.equal(phoneFromPnJid('12345@lid'), null);
  assert.equal(isLidJid('12345@lid'), true);
});

const allowedCallers = new Set(['12025550101']);
const baseDecision = {
  autoAcceptEnabled: true,
  allowlistValid: true,
  allowedCallers,
  peerJid: '987654321012345@lid',
  resolvedPhone: '12025550101',
  audioRequired: true,
  audioReady: true,
};

test('allows only an exact resolved phone match', () => {
  assert.deepEqual(
    evaluateAutoAcceptCallPolicy({ ...baseDecision, skipIdentity: true, resolvedPhone: null }),
    { allowed: true, reason: 'identity-required' },
  );
  assert.deepEqual(
    evaluateAutoAcceptCallPolicy(baseDecision),
    { allowed: true, reason: 'allowed', resolvedPhone: '12025550101' },
  );
  assert.equal(
    evaluateAutoAcceptCallPolicy({ ...baseDecision, resolvedPhone: '12025550102' }).reason,
    'caller-not-allowed',
  );
  assert.equal(
    evaluateAutoAcceptCallPolicy({ ...baseDecision, resolvedPhone: null }).reason,
    'unresolved-lid',
  );
});

test('fails closed before caller matching for unsafe call conditions', () => {
  const cases = [
    [{ autoAcceptEnabled: false }, 'auto-disabled'],
    [{ allowlistValid: false }, 'invalid-config'],
    [{ allowedCallers: new Set() }, 'allowlist-empty'],
    [{ duplicate: true }, 'duplicate-call'],
    [{ fromMe: true }, 'from-self'],
    [{ isGroup: true }, 'group-call'],
    [{ isVideo: true }, 'video-call'],
    [{ audioReady: false }, 'audio-unavailable'],
    [{ callAlreadyActive: true }, 'call-already-active'],
  ];
  for (const [override, expected] of cases) {
    assert.equal(evaluateAutoAcceptCallPolicy({ ...baseDecision, ...override }).reason, expected);
  }
});

test('allows bot audio only for the current nonterminal call lifecycle', () => {
  const baseLifecycle = {
    callId: 'call-a',
    peerJid: '12025550101@c.us',
    activeCallId: 'call-a',
    activeCallPeerJid: '12025550101@c.us',
    activeCallStatus: 'playing-bot-audio',
    automationState: 'accepting',
    automatic: true,
    automaticReservationId: 'call-a',
    automaticReservationPeerJid: '12025550101@c.us',
  };
  assert.deepEqual(
    evaluateBotAudioLifecycle(baseLifecycle),
    { allowed: true, reason: 'active-call' },
  );
  const cases = [
    [{ automationState: 'terminal' }, 'terminal-automation-state'],
    [{ activeCallStatus: 'call-ended' }, 'terminal-call-status'],
    [{ activeCallId: 'call-b' }, 'active-call-mismatch'],
    [{ activeCallPeerJid: '12025550102@c.us' }, 'active-call-peer-mismatch'],
    [{ automaticReservationId: 'call-b' }, 'automatic-call-reservation-lost'],
    [{ automaticReservationPeerJid: '12025550102@c.us' }, 'automatic-call-reservation-lost'],
  ];
  for (const [override, reason] of cases) {
    assert.equal(evaluateBotAudioLifecycle({ ...baseLifecycle, ...override }).reason, reason);
  }
  assert.equal(
    evaluateBotAudioLifecycle({ ...baseLifecycle, callId: 123, activeCallId: '123' }).reason,
    'missing-call-id',
  );
  assert.equal(
    evaluateBotAudioLifecycle({ ...baseLifecycle, activeCallId: 123 }).reason,
    'active-call-mismatch',
  );
  assert.equal(
    evaluateBotAudioLifecycle({ ...baseLifecycle, automationState: 'denied', automatic: false }).allowed,
    true,
  );
});