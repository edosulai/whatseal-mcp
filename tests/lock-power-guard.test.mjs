import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLockPowerGuard,
  decidePowerPause,
  isLockPowerGuardEnabled,
  parseClamshellState,
  parseScreenLockState,
  readPowerSessionState,
} from '../lib/lock-power-guard.mjs';

test('lock power guard enabled by default', () => {
  assert.equal(isLockPowerGuardEnabled({}), true);
  assert.equal(isLockPowerGuardEnabled({ LOCK_POWER_GUARD: '1' }), true);
  assert.equal(isLockPowerGuardEnabled({ LOCK_POWER_GUARD: '0' }), false);
});

test('parse clamshell and screen lock payloads', () => {
  assert.deepEqual(parseClamshellState('"AppleClamshellState" = Yes'), {
    available: true,
    lidClosed: true,
  });
  assert.deepEqual(parseClamshellState('"AppleClamshellState" = No'), {
    available: true,
    lidClosed: false,
  });
  assert.deepEqual(parseScreenLockState('{"screenLocked":true}'), {
    available: true,
    screenLocked: true,
  });
  assert.deepEqual(parseScreenLockState('CGSSessionScreenIsLocked = 0'), {
    available: true,
    screenLocked: false,
  });
});

test('pause when locked or lid closed', () => {
  assert.equal(decidePowerPause({ screenLocked: true, lidClosed: false }).shouldPause, true);
  assert.equal(decidePowerPause({ screenLocked: false, lidClosed: true }).shouldPause, true);
  assert.equal(decidePowerPause({ screenLocked: false, lidClosed: false }).shouldPause, false);
  assert.equal(
    decidePowerPause({ screenLocked: true, lidClosed: true }).reason,
    'screen_locked+lid_closed',
  );
});

test('force override for smoke tests', async () => {
  const locked = await readPowerSessionState({ env: { LOCK_POWER_GUARD_FORCE: 'locked' } });
  assert.equal(locked.shouldPause, true);
  assert.equal(locked.source, 'force');
  const unlocked = await readPowerSessionState({ env: { LOCK_POWER_GUARD_FORCE: 'unlocked' } });
  assert.equal(unlocked.shouldPause, false);
  assert.equal(unlocked.source, 'force');
});

test('guard pauses and resumes only when previously paused by itself', async () => {
  const events = [];
  let locked = true;
  const guard = createLockPowerGuard({
    enabled: true,
    intervalMs: 60_000,
    readState: async () => {
      const decision = decidePowerPause({ screenLocked: locked, lidClosed: false });
      return {
        screenLocked: locked,
        lidClosed: false,
        shouldPause: decision.shouldPause,
        reason: decision.reason,
        reasons: decision.reasons,
        source: 'test',
        available: { screenLocked: true, lidClosed: true },
      };
    },
    onPause: async (state) => {
      events.push(`pause:${state.reason}`);
    },
    onResume: async () => {
      events.push('resume');
    },
    now: () => 't0',
  });

  await guard.start();
  assert.equal(guard.isPausedByLock(), true);
  assert.equal(guard.getStatus().paused_by_lock, true);
  assert.deepEqual(events, ['pause:screen_locked']);

  // Still locked: no duplicate pause.
  await guard.pollOnce();
  assert.deepEqual(events, ['pause:screen_locked']);

  locked = false;
  await guard.pollOnce();
  assert.equal(guard.isPausedByLock(), false);
  assert.deepEqual(events, ['pause:screen_locked', 'resume']);

  // Unlocked again: no spurious resume.
  await guard.pollOnce();
  assert.deepEqual(events, ['pause:screen_locked', 'resume']);

  await guard.stop();
});

test('disabled guard never pauses', async () => {
  let paused = 0;
  const guard = createLockPowerGuard({
    enabled: false,
    readState: async () => ({
      screenLocked: true,
      lidClosed: true,
      shouldPause: true,
      reason: 'screen_locked+lid_closed',
      reasons: ['screen_locked', 'lid_closed'],
      source: 'test',
      available: { screenLocked: true, lidClosed: true },
    }),
    onPause: async () => {
      paused += 1;
    },
  });
  await guard.start();
  await guard.pollOnce();
  assert.equal(paused, 0);
  assert.equal(guard.isPausedByLock(), false);
  await guard.stop();
});
