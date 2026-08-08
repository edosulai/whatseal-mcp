import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBrowserLifecycleStatus,
  isIdleColdPhase,
  methodNeedsBrowser,
  parseIdleChromeMs,
  parseBrowserPolicy,
  parseMaxHotBrowsers,
  shouldIdleCloseBrowser,
  shouldStartBrowserOnBoot,
} from '../lib/browser-lifecycle.mjs';

test('browser policy defaults to idle and accepts aliases', () => {
  assert.equal(parseBrowserPolicy({}), 'idle');
  assert.equal(parseBrowserPolicy({ BROWSER_POLICY: 'always' }), 'always');
  assert.equal(parseBrowserPolicy({ BROWSER_POLICY: 'on-demand' }), 'on_demand');
  assert.equal(parseBrowserPolicy({ WHATSAPP_BROWSER_POLICY: 'hot' }), 'always');
  assert.equal(parseBrowserPolicy({ BROWSER_POLICY: 'nope' }), 'idle');
});

test('IDLE_CHROME_MS defaults to 15m; legacy BROWSER_IDLE_MS accepted; 0 disables', () => {
  assert.equal(parseIdleChromeMs({}), 900_000);
  assert.equal(parseIdleChromeMs({ IDLE_CHROME_MS: '0' }), 0);
  assert.equal(parseIdleChromeMs({ IDLE_CHROME_MS: '120000' }), 120_000);
  assert.equal(parseIdleChromeMs({ BROWSER_IDLE_MS: '60000' }), 60_000);
  assert.equal(parseIdleChromeMs({ IDLE_CHROME_MS: 'bogus' }), 900_000);
  assert.equal(parseMaxHotBrowsers({}), 1);
  assert.equal(parseMaxHotBrowsers({ MAX_HOT_BROWSERS: '2' }), 2);
  assert.equal(parseMaxHotBrowsers({ MAX_HOT_BROWSERS: '0' }), 1);
});

test('boot start only for always/idle', () => {
  assert.equal(shouldStartBrowserOnBoot('always'), true);
  assert.equal(shouldStartBrowserOnBoot('idle'), true);
  assert.equal(shouldStartBrowserOnBoot('on_demand'), false);
});

test('idle close only when warm ready browser exceeds timeout', () => {
  const now = 1_000_000;
  assert.equal(
    shouldIdleCloseBrowser({
      policy: 'idle',
      idleChromeMs: 60_000,
      now,
      lastRpcAt: now - 61_000,
      phase: 'ready',
      chromeAlive: true,
    }).shouldClose,
    true,
  );
  assert.equal(
    shouldIdleCloseBrowser({
      policy: 'always',
      idleChromeMs: 1,
      now,
      lastRpcAt: now - 999_999,
      phase: 'ready',
      chromeAlive: true,
    }).shouldClose,
    false,
  );
  assert.equal(
    shouldIdleCloseBrowser({
      policy: 'idle',
      idleChromeMs: 60_000,
      now,
      lastRpcAt: now - 61_000,
      phase: 'ready',
      chromeAlive: true,
      hasActiveBotCall: true,
    }).shouldClose,
    false,
  );
  assert.equal(
    shouldIdleCloseBrowser({
      policy: 'idle',
      idleChromeMs: 60_000,
      now,
      lastRpcAt: now - 10_000,
      phase: 'ready',
      chromeAlive: true,
    }).shouldClose,
    false,
  );
  assert.equal(
    shouldIdleCloseBrowser({
      policy: 'idle',
      idleChromeMs: 60_000,
      now,
      lastRpcAt: now - 61_000,
      phase: 'ready',
      chromeAlive: true,
      pausedByLock: true,
    }).shouldClose,
    false,
  );
  assert.equal(
    shouldIdleCloseBrowser({
      policy: 'idle',
      idleChromeMs: 0,
      now,
      lastRpcAt: now - 999_999,
      phase: 'ready',
      chromeAlive: true,
    }).shouldClose,
    false,
  );
});

test('status snapshot uses instaseal contract fields', () => {
  const snap = buildBrowserLifecycleStatus({
    policy: 'idle',
    idleChromeMs: 900_000,
    now: 2_000_000,
    lastRpcAt: 1_400_000,
    chromeAlive: false,
    phase: 'idle_cold',
    nodeRssBytes: 50 * 1024 * 1024,
    canWake: true,
  });
  assert.equal(snap.chromeAlive, false);
  assert.equal(snap.chrome_alive, false);
  assert.equal(snap.browserOpen, false); // legacy alias
  assert.equal(snap.canWake, true);
  assert.equal(snap.idleForMs, 600_000);
  assert.equal(snap.idle_for_ms, 600_000);
  assert.equal(snap.idleChromeMs, 900_000);
  assert.equal(snap.browserPolicy, 'idle');
  assert.equal(snap.nodeRssMb, 50);
  assert.ok(snap.lastRpcAt);
  assert.equal(methodNeedsBrowser('status'), false);
  assert.equal(methodNeedsBrowser('listChats'), true);
  assert.equal(methodNeedsBrowser('getSendOutcome'), false);
  assert.equal(methodNeedsBrowser('prepareSend'), true);
  assert.equal(isIdleColdPhase('idle_cold'), true);
  assert.equal(isIdleColdPhase('idle_no_browser'), true);
  assert.equal(isIdleColdPhase('ready'), false);
});
