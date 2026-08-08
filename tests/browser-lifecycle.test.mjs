import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProcessStatus,
  methodNeedsBrowser,
  parseBrowserIdleMs,
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

test('idle ms and max hot browsers parse safely', () => {
  assert.equal(parseBrowserIdleMs({}), 600_000);
  assert.equal(parseBrowserIdleMs({ BROWSER_IDLE_MS: '0' }), 0);
  assert.equal(parseBrowserIdleMs({ BROWSER_IDLE_MS: 'bogus' }), 600_000);
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
      idleMs: 60_000,
      now,
      lastActivityAt: now - 61_000,
      phase: 'ready',
      browserOpen: true,
    }).shouldClose,
    true,
  );
  assert.equal(
    shouldIdleCloseBrowser({
      policy: 'always',
      idleMs: 1,
      now,
      lastActivityAt: now - 999_999,
      phase: 'ready',
      browserOpen: true,
    }).shouldClose,
    false,
  );
  assert.equal(
    shouldIdleCloseBrowser({
      policy: 'idle',
      idleMs: 60_000,
      now,
      lastActivityAt: now - 61_000,
      phase: 'ready',
      browserOpen: true,
      hasActiveBotCall: true,
    }).shouldClose,
    false,
  );
  assert.equal(
    shouldIdleCloseBrowser({
      policy: 'idle',
      idleMs: 60_000,
      now,
      lastActivityAt: now - 10_000,
      phase: 'ready',
      browserOpen: true,
    }).shouldClose,
    false,
  );
  assert.equal(
    shouldIdleCloseBrowser({
      policy: 'idle',
      idleMs: 60_000,
      now,
      lastActivityAt: now - 61_000,
      phase: 'ready',
      browserOpen: true,
      pausedByLock: true,
    }).shouldClose,
    false,
  );
});

test('status process snapshot and socket-only methods', () => {
  const snap = buildProcessStatus({
    policy: 'idle',
    idleMs: 600_000,
    now: 2_000_000,
    lastActivityAt: 1_400_000,
    browserOpen: false,
    phase: 'idle_no_browser',
    nodeRssBytes: 50 * 1024 * 1024,
    canWake: true,
  });
  assert.equal(snap.browserOpen, false);
  assert.equal(snap.canWake, true);
  assert.equal(snap.idleForSec, 600);
  assert.equal(snap.nodeRssMb, 50);
  assert.equal(methodNeedsBrowser('status'), false);
  assert.equal(methodNeedsBrowser('listChats'), true);
  assert.equal(methodNeedsBrowser('getSendOutcome'), false);
  assert.equal(methodNeedsBrowser('prepareSend'), true);
});
