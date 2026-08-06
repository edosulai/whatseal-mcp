const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;

export function normalizeCallerPhone(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || !/^\+?[0-9().\s-]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, '');
  if (!new RegExp(`^[1-9]\\d{${MIN_PHONE_DIGITS - 1},${MAX_PHONE_DIGITS - 1}}$`).test(digits)) {
    return null;
  }
  return digits;
}

export function parseAutoAcceptCallers(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { valid: true, callers: [], invalidEntries: [] };

  const callers = [];
  const invalidEntries = [];
  const seen = new Set();
  for (const entry of raw.split(',')) {
    const normalized = normalizeCallerPhone(entry);
    if (!normalized) {
      invalidEntries.push(entry.trim());
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      callers.push(normalized);
    }
  }
  return {
    valid: invalidEntries.length === 0,
    callers,
    invalidEntries,
  };
}

export function serializePeerJid(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  if (typeof value._serialized === 'string') return value._serialized.trim();
  if (typeof value.$1 === 'string') return value.$1.trim();
  if (value.user && value.server) return `${value.user}@${value.server}`;
  return '';
}

export function phoneFromPnJid(value) {
  const jid = serializePeerJid(value).toLowerCase();
  const match = jid.match(/^([1-9]\d{7,14})@(c\.us|s\.whatsapp\.net)$/);
  return match ? match[1] : null;
}

export function isLidJid(value) {
  return /^\d+@lid$/i.test(serializePeerJid(value));
}

export function evaluateAutoAcceptCallPolicy({
  autoAcceptEnabled,
  allowlistValid,
  allowedCallers,
  duplicate = false,
  fromMe = false,
  isGroup = false,
  isVideo = false,
  audioRequired = false,
  audioReady = true,
  callAlreadyActive = false,
  skipIdentity = false,
  resolvedPhone = null,
  peerJid = '',
} = {}) {
  if (!autoAcceptEnabled) return { allowed: false, reason: 'auto-disabled' };
  if (!allowlistValid) return { allowed: false, reason: 'invalid-config' };

  const allowlist = allowedCallers instanceof Set
    ? allowedCallers
    : new Set(Array.isArray(allowedCallers) ? allowedCallers : []);
  if (allowlist.size === 0) return { allowed: false, reason: 'allowlist-empty' };
  if (duplicate) return { allowed: false, reason: 'duplicate-call' };
  if (fromMe) return { allowed: false, reason: 'from-self' };
  if (isGroup) return { allowed: false, reason: 'group-call' };
  if (isVideo) return { allowed: false, reason: 'video-call' };
  if (audioRequired && !audioReady) return { allowed: false, reason: 'audio-unavailable' };
  if (callAlreadyActive) return { allowed: false, reason: 'call-already-active' };
  if (skipIdentity) return { allowed: true, reason: 'identity-required' };

  const phone = normalizeCallerPhone(resolvedPhone || '');
  if (!phone) {
    return {
      allowed: false,
      reason: isLidJid(peerJid) ? 'unresolved-lid' : 'caller-unresolved',
    };
  }
  if (!allowlist.has(phone)) {
    return { allowed: false, reason: 'caller-not-allowed', resolvedPhone: phone };
  }
  return { allowed: true, reason: 'allowed', resolvedPhone: phone };
}

const TERMINAL_AUTOMATION_STATES = new Set(['terminal']);
const TERMINAL_BOT_CALL_STATUSES = new Set([
  'accept-failed',
  'audio-failed',
  'audio-failed-hung-up',
  'call-ended',
  'completed',
  'error',
  'hung-up',
]);

export function evaluateBotAudioLifecycle({
  callId,
  peerJid,
  activeCallId,
  activeCallPeerJid,
  activeCallStatus = null,
  automationState = null,
  automatic = false,
  automaticReservationId = null,
  automaticReservationPeerJid = null,
} = {}) {
  const expectedId = typeof callId === 'string' ? callId : '';
  const expectedPeer = serializePeerJid(peerJid);
  if (!expectedId) return { allowed: false, reason: 'missing-call-id' };
  if (!expectedPeer) return { allowed: false, reason: 'missing-call-peer' };
  if (TERMINAL_AUTOMATION_STATES.has(automationState)) {
    return { allowed: false, reason: 'terminal-automation-state' };
  }
  if (TERMINAL_BOT_CALL_STATUSES.has(activeCallStatus)) {
    return { allowed: false, reason: 'terminal-call-status' };
  }
  if (typeof activeCallId !== 'string' || activeCallId !== expectedId) {
    return { allowed: false, reason: 'active-call-mismatch' };
  }
  if (serializePeerJid(activeCallPeerJid) !== expectedPeer) {
    return { allowed: false, reason: 'active-call-peer-mismatch' };
  }
  if (automatic && (
    typeof automaticReservationId !== 'string'
    || automaticReservationId !== expectedId
    || serializePeerJid(automaticReservationPeerJid) !== expectedPeer
  )) {
    return { allowed: false, reason: 'automatic-call-reservation-lost' };
  }
  return { allowed: true, reason: 'active-call' };
}