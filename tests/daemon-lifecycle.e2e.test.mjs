import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { accountPaths, rpcCall } from '../lib/core.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const isDarwin = process.platform === 'darwin';
const isWin32 = process.platform === 'win32';

async function waitFor(probe, {
  timeoutMs = 15_000,
  intervalMs = 50,
  message = 'condition was not met',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function canConnectTcp(port) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function writeLockState(file, screenLocked) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ screenLocked })}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function spawnDaemon(env) {
  const child = spawn(process.execPath, ['daemon.mjs'], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-20_000);
  });
  return { child, getStderr: () => stderr };
}

function waitForExit(child, timeoutMs = 10_000) {
  return Promise.race([
    new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`daemon did not exit within ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

function controlPathForEnv(accountId, env) {
  return accountPaths(accountId, { env }).socket;
}

function daemonEnv({ accountId, stateRoot, dataRoot, httpPort, extra = {} }) {
  return {
    ...process.env,
    WHATSAPP_ACCOUNT_ID: accountId,
    WHATSAPP_AGENT_STATE: stateRoot,
    WHATSAPP_AGENT_ROOT: dataRoot,
    WHATSAPP_HTTP_PORT: String(httpPort),
    BROWSER_POLICY: 'on_demand',
    WHATSEAL_WEB_API: '0',
    WHATSAPP_HTTP_API: '0',
    WHATSAPP_CALL_AUDIO_HTTP: '0',
    WHATSAPP_AUTO_ACCEPT_CALLS: '0',
    LOCK_POWER_GUARD: '0',
    ...extra,
  };
}

function stopChild(child, { force = false } = {}) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (isWin32) {
    child.kill();
    return;
  }
  child.kill(force ? 'SIGKILL' : 'SIGTERM');
}

async function waitUntilCold(socketPath, getStderr) {
  return waitFor(async () => {
    const next = await rpcCall('status', {}, { timeoutMs: 1000, socketPath }).catch(() => null);
    return next?.phase === 'idle_cold' ? next : null;
  }, { message: `daemon did not reach stable idle_cold\n${getStderr()}` });
}

test('cold daemon stays TCP-free and refuses directSend without waking Chrome', { timeout: 35_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'whatseal-daemon-e2e-'));
  const accountId = 'e2e';
  const stateRoot = path.join(temporaryRoot, 'state');
  const dataRoot = path.join(temporaryRoot, 'data');
  const httpPort = await reserveLoopbackPort();
  const env = daemonEnv({
    accountId,
    stateRoot,
    dataRoot,
    httpPort,
    extra: { IDLE_CHROME_MS: '1000' },
  });
  const socketPath = controlPathForEnv(accountId, env);
  const { child, getStderr } = spawnDaemon(env);
  let childExited = false;
  child.once('exit', () => {
    childExited = true;
  });

  t.after(async () => {
    if (!childExited) stopChild(child, { force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const status = await waitUntilCold(socketPath, getStderr);
  assert.equal(status.phase, 'idle_cold');
  assert.equal(status.chromeAlive, false);
  assert.equal(status.ready, false);
  assert.equal(await canConnectTcp(httpPort), false, 'default daemon must not bind TCP');

  const compatibility = await rpcCall('compatibility', {}, { timeoutMs: 15_000, socketPath });
  assert.equal(compatibility.phase, 'idle_cold');
  assert.equal(compatibility.runtime.browserVersion, null);
  const audit = await rpcCall('securityAudit', {}, { timeoutMs: 10_000, socketPath });
  assert.equal(audit.checks.find((entry) => entry.name === 'backend-tcp-listener')?.passed, true);
  assert.equal(audit.checks.find((entry) => entry.name === 'chrome-debug-transport')?.skippedWhileBrowserCold, true);
  const socketCheck = audit.checks.find((entry) => entry.name === 'control-socket');
  if (isWin32) {
    assert.equal(socketCheck, undefined, 'Windows named pipes must not be audited as filesystem sockets');
  } else {
    assert.equal(socketCheck?.passed, true);
  }
  const helperChecks = audit.checks.filter((entry) => /approval-helper$/.test(entry.name));
  if (isDarwin) {
    assert.equal(helperChecks.length, 2);
  } else {
    assert.equal(helperChecks.length, 0, 'Darwin approval helpers must not be required off Darwin');
  }
  assert.equal(status.lockPower?.enabled, false);

  await assert.rejects(
    rpcCall('directSend', { chat: 'nobody', text: 'must not send' }, { timeoutMs: 1000, socketPath }),
    /directSend is disabled/,
  );

  const stillCold = await rpcCall('status', {}, { timeoutMs: 1000, socketPath });
  assert.equal(stillCold.phase, 'idle_cold');
  assert.equal(stillCold.chromeAlive, false);

  stopChild(child);
  const exit = await waitForExit(child, 10_000).catch((error) => {
    throw new Error(`${error.message}\n${getStderr()}`);
  });
  if (!isWin32) {
    assert.deepEqual(exit, { code: 0, signal: null });
  }
});

test('daemon stays cold and TCP-free, then lock resume exits without deadlock', {
  timeout: 35_000,
  skip: isDarwin ? false : 'lock-power probes are Darwin-only',
}, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'whatseal-daemon-e2e-'));
  const accountId = 'e2e';
  const stateRoot = path.join(temporaryRoot, 'state');
  const dataRoot = path.join(temporaryRoot, 'data');
  const lockStateFile = path.join(temporaryRoot, 'lock-state.json');
  const lockHelper = path.join(temporaryRoot, 'lock-state-helper');
  const httpPort = await reserveLoopbackPort();
  await writeLockState(lockStateFile, false);
  await writeFile(
    lockHelper,
    '#!/bin/sh\nexec /bin/cat "$WHATSEAL_E2E_LOCK_STATE"\n',
    { mode: 0o500 },
  );
  await chmod(lockHelper, 0o500);

  const env = daemonEnv({
    accountId,
    stateRoot,
    dataRoot,
    httpPort,
    extra: {
      WHATSAPP_LOCK_STATE_HELPER: lockHelper,
      WHATSEAL_E2E_LOCK_STATE: lockStateFile,
      IDLE_CHROME_MS: '1000',
      LOCK_POWER_GUARD: '1',
      LOCK_POWER_GUARD_INTERVAL_MS: '100',
    },
  });
  const socketPath = controlPathForEnv(accountId, env);
  const { child, getStderr } = spawnDaemon(env);
  let childExited = false;
  child.once('exit', () => {
    childExited = true;
  });

  t.after(async () => {
    if (!childExited) stopChild(child, { force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const status = await waitUntilCold(socketPath, getStderr);
  assert.equal(status.phase, 'idle_cold');
  assert.equal(status.chromeAlive, false);
  assert.equal(status.ready, false);
  assert.equal(status.lockPower?.enabled, true);
  assert.equal(await canConnectTcp(httpPort), false, 'default daemon must not bind TCP');

  await writeLockState(lockStateFile, true);
  await waitFor(async () => {
    const next = await rpcCall('status', {}, { timeoutMs: 1000, socketPath }).catch(() => null);
    return next?.phase === 'paused_by_lock' && next?.paused_by_lock === true ? next : null;
  }, { message: `daemon did not enter paused_by_lock\n${getStderr()}` });

  await writeLockState(lockStateFile, false);
  const exit = await waitForExit(child, 10_000).catch((error) => {
    throw new Error(`${error.message}\n${getStderr()}`);
  });
  assert.deepEqual(exit, { code: 1, signal: null });
  assert.match(getStderr(), /event=shutdown-complete detail=signal=lock-power-resume/);
});

test('explicit Web API opt-in binds loopback without waking cold Chrome', { timeout: 20_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'whatseal-http-e2e-'));
  const accountId = 'http-e2e';
  const stateRoot = path.join(temporaryRoot, 'state');
  const dataRoot = path.join(temporaryRoot, 'data');
  const httpPort = await reserveLoopbackPort();
  const env = daemonEnv({
    accountId,
    stateRoot,
    dataRoot,
    httpPort,
    extra: {
      WHATSEAL_WEB_API: '1',
    },
  });
  const socketPath = controlPathForEnv(accountId, env);
  const { child, getStderr } = spawnDaemon(env);
  let childExited = false;
  child.once('exit', () => {
    childExited = true;
  });

  t.after(async () => {
    if (!childExited) stopChild(child, { force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await waitFor(
    () => canConnectTcp(httpPort),
    { message: `opt-in Web API did not bind loopback\n${getStderr()}` },
  );
  const statusResponse = await fetch(`http://127.0.0.1:${httpPort}/api/status`);
  assert.equal(statusResponse.status, 200);
  const statusPayload = await statusResponse.json();
  assert.equal(statusPayload.result.phase, 'idle_cold');
  assert.equal(statusPayload.result.chromeAlive, false);

  const rejectedSend = await fetch(`http://127.0.0.1:${httpPort}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: '', text: '' }),
  });
  assert.equal(rejectedSend.status, 400);
  assert.match((await rejectedSend.json()).error, /chatId and text required/);
  const stillCold = await rpcCall('status', {}, { timeoutMs: 1000, socketPath });
  assert.equal(stillCold.phase, 'idle_cold');
  assert.equal(stillCold.chromeAlive, false);

  stopChild(child);
  const exit = await waitForExit(child, 10_000).catch((error) => {
    throw new Error(`${error.message}\n${getStderr()}`);
  });
  if (!isWin32) {
    assert.deepEqual(exit, { code: 0, signal: null });
  }
});
