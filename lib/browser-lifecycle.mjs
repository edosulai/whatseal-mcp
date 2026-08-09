/**
 * Browser lifecycle policy helpers for bag-safe / low-memory WhatsApp daemons.
 * Pure functions — no Chrome, no sockets.
 *
 * Contract shared with instaseal-mcp (keep names identical):
 *   BROWSER_POLICY=idle|on_demand|always  (default idle)
 *   IDLE_CHROME_MS default 900000 (15m); 0 = never idle-close
 *   Status: chromeAlive, browserPolicy, idleChromeMs, idleForMs, lastRpcAt
 *   Cold phase: idle_cold  (paused_by_lock always wins over idle_cold)
 */

export const BROWSER_POLICIES = Object.freeze(['always', 'idle', 'on_demand']);

/** Canonical cold phase name (instaseal-compatible). */
export const IDLE_COLD_PHASE = 'idle_cold';

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
 * Primary env: IDLE_CHROME_MS (instaseal contract). Default 15 minutes.
 * Legacy alias: BROWSER_IDLE_MS / WHATSAPP_BROWSER_IDLE_MS.
 * Set 0 to disable idle close even when policy is idle/on_demand.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function parseIdleChromeMs(env = process.env) {
  const raw = env.IDLE_CHROME_MS
    ?? env.BROWSER_IDLE_MS
    ?? env.WHATSAPP_BROWSER_IDLE_MS
    ?? '900000';
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 900_000;
  return Math.floor(value);
}

/** @deprecated Use parseIdleChromeMs — kept for in-repo call sites during rename. */
export const parseBrowserIdleMs = parseIdleChromeMs;

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
 * Lock/clamshell pause always wins (never idle-close while paused_by_lock).
 */
export function shouldIdleCloseBrowser({
  policy = 'idle',
  idleChromeMs = 900_000,
  idleMs = null, // legacy alias
  now = Date.now(),
  lastRpcAt = null,
  lastActivityAt = null, // legacy alias
  phase = 'ready',
  pausedByLock = false,
  chromeAlive = false,
  browserOpen = null, // legacy alias
  hasActiveBotCall = false,
  sendApprovalInFlight = false,
  activeBrowserOperations = 0,
} = {}) {
  const timeoutMs = idleMs != null ? idleMs : idleChromeMs;
  const lastRpc = lastRpcAt != null ? lastRpcAt : lastActivityAt;
  const alive = browserOpen != null ? Boolean(browserOpen) : Boolean(chromeAlive);

  if (pausedByLock) {
    return { shouldClose: false, reason: 'paused_by_lock' };
  }
  if (policy === 'always') {
    return { shouldClose: false, reason: 'policy_always' };
  }
  if (policy !== 'idle' && policy !== 'on_demand') {
    return { shouldClose: false, reason: 'policy_unknown' };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { shouldClose: false, reason: 'idle_disabled' };
  }
  if (!alive) {
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
  if (Number(activeBrowserOperations) > 0) {
    return { shouldClose: false, reason: 'browser_operation_in_flight' };
  }
  if (lastRpc == null) {
    return { shouldClose: false, reason: 'no_activity_timestamp' };
  }
  const idleForMs = Math.max(0, Number(now) - Number(lastRpc));
  if (idleForMs < timeoutMs) {
    return { shouldClose: false, reason: 'still_warm', idleForMs, idleChromeMs: timeoutMs, idleMs: timeoutMs };
  }
  return { shouldClose: true, reason: 'idle_timeout', idleForMs, idleChromeMs: timeoutMs, idleMs: timeoutMs };
}

/**
 * Build the browserLifecycle / process snapshot for status (instaseal-compatible fields).
 */
export function buildBrowserLifecycleStatus({
  policy = 'idle',
  idleChromeMs = 900_000,
  idleMs = null,
  now = Date.now(),
  lastRpcAt = null,
  lastActivityAt = null,
  chromeAlive = false,
  browserOpen = null,
  phase = 'starting',
  pausedByLock = false,
  nodeRssBytes = null,
  canWake = false,
} = {}) {
  const timeoutMs = idleMs != null ? idleMs : idleChromeMs;
  const lastRpc = lastRpcAt != null ? lastRpcAt : lastActivityAt;
  const alive = browserOpen != null ? Boolean(browserOpen) : Boolean(chromeAlive);
  const idleForMs = lastRpc == null
    ? null
    : Math.max(0, Number(now) - Number(lastRpc));
  const rssMb = Number.isFinite(nodeRssBytes)
    ? Math.round((Number(nodeRssBytes) / (1024 * 1024)) * 10) / 10
    : null;
  const lastRpcIso = lastRpc
    ? new Date(Number(lastRpc)).toISOString()
    : null;
  return {
    // instaseal contract fields
    policy,
    browserPolicy: policy,
    idleChromeMs: timeoutMs,
    chromeAlive: alive,
    chrome_alive: alive,
    lastRpcAt: lastRpcIso,
    idleForMs,
    idle_for_ms: idleForMs,
    canWake: Boolean(canWake),
    phase,
    pausedByLock: Boolean(pausedByLock),
    // whatseal extras / legacy aliases
    idleMs: timeoutMs,
    browserOpen: alive,
    lastActivityAt: lastRpcIso,
    idleForSec: idleForMs == null ? null : Math.floor(idleForMs / 1000),
    nodeRssMb: rssMb,
  };
}

/** @deprecated Use buildBrowserLifecycleStatus */
export const buildProcessStatus = buildBrowserLifecycleStatus;

/**
 * Coordinate browser-operation admission with destructive lifecycle transitions.
 *
 * A transition holds the admission lock for its complete callback. New browser
 * operations therefore wait for an idle teardown to finish. Admitted operations
 * release the lock immediately after incrementing the active count, allowing a
 * lock/clamshell transition to pre-empt them while idle teardown fails closed.
 */
export function createBrowserOperationCoordinator() {
  let transitionTail = Promise.resolve();
  let activeOperations = 0;
  const activeLabels = new Map();

  const withTransition = async (operation) => {
    const previous = transitionTail;
    let releaseTransition;
    transitionTail = new Promise((resolve) => {
      releaseTransition = resolve;
    });
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      releaseTransition();
    }
  };

  const beginOperation = async (label = 'browser-operation') => await withTransition(async () => {
    const normalized = String(label || 'browser-operation');
    activeOperations += 1;
    activeLabels.set(normalized, (activeLabels.get(normalized) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeOperations = Math.max(0, activeOperations - 1);
      const remaining = (activeLabels.get(normalized) || 1) - 1;
      if (remaining > 0) activeLabels.set(normalized, remaining);
      else activeLabels.delete(normalized);
    };
  });

  return {
    beginOperation,
    withTransition,
    getStatus: () => ({
      activeOperations,
      activeLabels: Object.fromEntries(activeLabels),
    }),
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
    'securityAudit',
    'getSendOutcome',
    'getLastCall',
    'getCallBotConfig',
    'getChatLockSecretStatus',
    'setChatLockSecret',
  ]);
  return !socketOnly.has(name);
}

/**
 * True when phase is a cold control-socket state (Chrome intentionally down).
 */
export function isIdleColdPhase(phase) {
  return phase === IDLE_COLD_PHASE || phase === 'idle_no_browser';
}
