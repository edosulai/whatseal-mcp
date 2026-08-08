/**
 * Browser lifecycle policy helpers for bag-safe / low-memory WhatsApp daemons.
 * Pure functions — no Chrome, no sockets.
 */

export const BROWSER_POLICIES = Object.freeze(['always', 'idle', 'on_demand']);

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {'always' | 'idle' | 'on_demand'}
 */
export function parseBrowserPolicy(env = process.env) {
  const raw = String(env.BROWSER_POLICY ?? env.WHATSAPP_BROWSER_POLICY ?? 'idle')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (raw === 'always' || raw === 'hot' || raw === 'ready') return 'always';
  if (raw === 'on_demand' || raw === 'ondemand' || raw === 'demand' || raw === 'cold') {
    return 'on_demand';
  }
  // Default and unknown values: idle (close Chrome after inactivity).
  return 'idle';
}

/**
 * Idle timeout before tearing down Chrome while keeping the control socket.
 * Default 10 minutes. Set 0 to disable idle close even when policy is idle.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function parseBrowserIdleMs(env = process.env) {
  const raw = env.BROWSER_IDLE_MS ?? env.WHATSAPP_BROWSER_IDLE_MS ?? '600000';
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 600_000;
  return Math.floor(value);
}

/**
 * Soft per-tool cap for concurrent hot browsers (documentation / future multi-account).
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function parseMaxHotBrowsers(env = process.env) {
  const raw = env.MAX_HOT_BROWSERS ?? env.WHATSAPP_MAX_HOT_BROWSERS ?? '1';
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

/**
 * Whether cold start should open Chrome immediately.
 * - always / idle → warm start (Chrome up after unlock)
 * - on_demand → wait for first RPC that needs WhatsApp
 */
export function shouldStartBrowserOnBoot(policy) {
  return policy === 'always' || policy === 'idle';
}

/**
 * Decide whether to tear down Chrome after inactivity.
 */
export function shouldIdleCloseBrowser({
  policy = 'idle',
  idleMs = 600_000,
  now = Date.now(),
  lastActivityAt = null,
  phase = 'ready',
  pausedByLock = false,
  browserOpen = false,
  hasActiveBotCall = false,
  sendApprovalInFlight = false,
} = {}) {
  if (pausedByLock) {
    return { shouldClose: false, reason: 'paused_by_lock' };
  }
  if (policy === 'always') {
    return { shouldClose: false, reason: 'policy_always' };
  }
  if (policy !== 'idle' && policy !== 'on_demand') {
    return { shouldClose: false, reason: 'policy_unknown' };
  }
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    return { shouldClose: false, reason: 'idle_disabled' };
  }
  if (!browserOpen) {
    return { shouldClose: false, reason: 'browser_already_closed' };
  }
  if (phase !== 'ready') {
    return { shouldClose: false, reason: 'phase_not_ready' };
  }
  if (hasActiveBotCall) {
    return { shouldClose: false, reason: 'active_bot_call' };
  }
  if (sendApprovalInFlight) {
    return { shouldClose: false, reason: 'approval_in_flight' };
  }
  if (lastActivityAt == null) {
    return { shouldClose: false, reason: 'no_activity_timestamp' };
  }
  const idleForMs = Math.max(0, Number(now) - Number(lastActivityAt));
  if (idleForMs < idleMs) {
    return { shouldClose: false, reason: 'still_warm', idleForMs, idleMs };
  }
  return { shouldClose: true, reason: 'idle_timeout', idleForMs, idleMs };
}

/**
 * Build the process/browser section of status for observability.
 */
export function buildProcessStatus({
  policy = 'idle',
  idleMs = 600_000,
  now = Date.now(),
  lastActivityAt = null,
  browserOpen = false,
  phase = 'starting',
  pausedByLock = false,
  nodeRssBytes = null,
  canWake = false,
} = {}) {
  const idleForMs = lastActivityAt == null
    ? null
    : Math.max(0, Number(now) - Number(lastActivityAt));
  const rssMb = Number.isFinite(nodeRssBytes)
    ? Math.round((Number(nodeRssBytes) / (1024 * 1024)) * 10) / 10
    : null;
  return {
    policy,
    idleMs,
    browserOpen: Boolean(browserOpen),
    canWake: Boolean(canWake),
    lastActivityAt: lastActivityAt
      ? new Date(Number(lastActivityAt)).toISOString()
      : null,
    idleForSec: idleForMs == null ? null : Math.floor(idleForMs / 1000),
    nodeRssMb: rssMb,
    phase,
    pausedByLock: Boolean(pausedByLock),
  };
}

/**
 * Methods that only need the control socket (no WhatsApp Chrome).
 */
export function methodNeedsBrowser(method) {
  const name = String(method || '');
  const socketOnly = new Set([
    'status',
    'compatibility',
    'compatibilitySelfTest',
    'securityAudit',
    'getSendOutcome',
    'getCallBotConfig',
    'getChatLockSecretStatus',
  ]);
  return !socketOnly.has(name);
}
