import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function isLockPowerGuardEnabled(env = process.env) {
  return String(env.LOCK_POWER_GUARD ?? '1') !== '0';
}

export function parseClamshellState(ioregStdout = '') {
  const match = String(ioregStdout).match(/"AppleClamshellState"\s*=\s*(Yes|No)/i);
  if (!match) return { available: false, lidClosed: false };
  return { available: true, lidClosed: match[1].toLowerCase() === 'yes' };
}

export function parseScreenLockState(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return { available: false, screenLocked: false };

  // Preferred: JSON from native helper / force harness.
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.screenLocked === 'boolean') {
        return { available: true, screenLocked: parsed.screenLocked };
      }
      if (typeof parsed.locked === 'boolean') {
        return { available: true, screenLocked: parsed.locked };
      }
    } catch {
      // fall through
    }
  }

  // CGSession key dumps or plain 0/1/true/false.
  if (/CGSSessionScreenIsLocked\s*[:=]\s*(1|true|yes)/i.test(text)) {
    return { available: true, screenLocked: true };
  }
  if (/CGSSessionScreenIsLocked\s*[:=]\s*(0|false|no)/i.test(text)) {
    return { available: true, screenLocked: false };
  }
  if (/^(1|true|yes|locked)$/i.test(text)) return { available: true, screenLocked: true };
  if (/^(0|false|no|unlocked)$/i.test(text)) return { available: true, screenLocked: false };
  return { available: false, screenLocked: false };
}

export function decidePowerPause({ screenLocked = false, lidClosed = false } = {}) {
  const reasons = [];
  if (screenLocked) reasons.push('screen_locked');
  if (lidClosed) reasons.push('lid_closed');
  return {
    shouldPause: reasons.length > 0,
    reason: reasons.join('+') || null,
    reasons,
  };
}

/**
 * Read lock + clamshell state using only local macOS tools / optional helper.
 * LOCK_POWER_GUARD_FORCE=locked|unlocked overrides detection (tests/smoke).
 */
export async function readPowerSessionState({
  env = process.env,
  execFileImpl = execFileAsync,
  lockHelperPath = null,
} = {}) {
  const force = String(env.LOCK_POWER_GUARD_FORCE || '').trim().toLowerCase();
  if (force === 'locked' || force === 'pause' || force === '1') {
    return {
      screenLocked: true,
      lidClosed: false,
      shouldPause: true,
      reason: 'forced_locked',
      reasons: ['forced_locked'],
      source: 'force',
      available: { screenLocked: true, lidClosed: true },
    };
  }
  if (force === 'unlocked' || force === 'resume' || force === '0') {
    return {
      screenLocked: false,
      lidClosed: false,
      shouldPause: false,
      reason: null,
      reasons: [],
      source: 'force',
      available: { screenLocked: true, lidClosed: true },
    };
  }

  let screenLocked = false;
  let screenAvailable = false;
  let lidClosed = false;
  let lidAvailable = false;

  try {
    const { stdout } = await execFileImpl('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4'], {
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = parseClamshellState(stdout);
    lidAvailable = parsed.available;
    lidClosed = parsed.lidClosed;
  } catch {
    lidAvailable = false;
    lidClosed = false;
  }

  if (lockHelperPath) {
    try {
      const { stdout } = await execFileImpl(lockHelperPath, [], {
        timeout: 3000,
        maxBuffer: 64 * 1024,
      });
      const parsed = parseScreenLockState(stdout);
      screenAvailable = parsed.available;
      screenLocked = parsed.screenLocked;
    } catch {
      // fall through to CGSession probe
    }
  }

  if (!screenAvailable) {
    try {
      // Lightweight Swift probe using system frameworks. No third-party deps.
      const script = [
        'import CoreGraphics',
        'import Foundation',
        'let dict = CGSessionCopyCurrentDictionary() as? [String: Any]',
        'let locked: Bool',
        'if let value = dict?["CGSSessionScreenIsLocked"] as? Bool { locked = value }',
        'else if let value = dict?["CGSSessionScreenIsLocked"] as? Int { locked = value != 0 }',
        'else if let value = dict?["CGSSessionScreenIsLocked"] as? NSNumber { locked = value.boolValue }',
        'else { locked = false }',
        'let payload: [String: Any] = ["screenLocked": locked]',
        'let data = try! JSONSerialization.data(withJSONObject: payload, options: [])',
        'FileHandle.standardOutput.write(data)',
      ].join('\n');
      const { stdout } = await execFileImpl('/usr/bin/swift', ['-e', script], {
        timeout: 8000,
        maxBuffer: 64 * 1024,
      });
      const parsed = parseScreenLockState(stdout);
      screenAvailable = parsed.available;
      screenLocked = parsed.screenLocked;
    } catch {
      screenAvailable = false;
      screenLocked = false;
    }
  }

  const decision = decidePowerPause({ screenLocked, lidClosed });
  return {
    screenLocked,
    lidClosed,
    shouldPause: decision.shouldPause,
    reason: decision.reason,
    reasons: decision.reasons,
    source: 'system',
    available: {
      screenLocked: screenAvailable,
      lidClosed: lidAvailable,
    },
  };
}

/**
 * In-process guard. Keeps the Node process alive; callers pause/resume hot work.
 * Never uses caffeinate / prevent-sleep.
 */
export function createLockPowerGuard({
  enabled = true,
  intervalMs = 5000,
  readState = readPowerSessionState,
  onPause = async () => {},
  onResume = async () => {},
  log = { info() {}, error() {}, debug() {} },
  now = () => new Date().toISOString(),
} = {}) {
  let timer = null;
  let running = false;
  let inFlight = Promise.resolve();
  let pausedByLock = false;
  let lastState = {
    screenLocked: false,
    lidClosed: false,
    shouldPause: false,
    reason: null,
    reasons: [],
    source: 'init',
    available: { screenLocked: false, lidClosed: false },
  };
  let pausedAt = null;
  let lastTransitionAt = null;
  let lastError = null;
  const callbackContext = new AsyncLocalStorage();
  const callbackToken = Object.freeze({ guard: 'lock-power' });

  const getStatus = () => ({
    enabled: Boolean(enabled),
    running,
    pausedByLock,
    paused_by_lock: pausedByLock,
    pausedAt,
    lastTransitionAt,
    lastError,
    intervalMs,
    ...lastState,
  });

  const apply = async () => {
    if (!enabled || !running) return;
    try {
      const state = await readState();
      lastState = state;
      lastError = null;
      if (state.shouldPause && !pausedByLock) {
        log.info('lock-power-pause', state.reason || 'locked');
        await callbackContext.run(callbackToken, () => onPause(state));
        pausedByLock = true;
        pausedAt = now();
        lastTransitionAt = pausedAt;
      } else if (!state.shouldPause && pausedByLock) {
        log.info('lock-power-resume', 'unlocked_lid_open');
        await callbackContext.run(callbackToken, () => onResume(state));
        pausedByLock = false;
        pausedAt = null;
        lastTransitionAt = now();
      }
    } catch (error) {
      lastError = error?.message || String(error);
      log.error('lock-power-guard-failed', lastError);
    }
  };

  const tick = () => {
    inFlight = inFlight.catch(() => {}).then(apply);
    return inFlight;
  };

  return {
    getStatus,
    isPausedByLock: () => pausedByLock,
    async start() {
      if (!enabled || running) return getStatus();
      running = true;
      log.info('lock-power-guard-start', `intervalMs=${intervalMs}`);
      await tick();
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      return getStatus();
    },
    async stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
      // Await normal callers, but never await the promise that represents the
      // currently executing callback when stop() is invoked from that callback.
      if (callbackContext.getStore() !== callbackToken) {
        await inFlight.catch(() => {});
      }
      return getStatus();
    },
    /** Test helper / manual kick. */
    async pollOnce() {
      return tick();
    },
  };
}
