import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { shouldExitProcessOnLockResume } from '../lib/lock-power-guard.mjs';
import {
  sessionDaemonLogFiles,
  sessionDaemonPidFile,
  sessionDaemonSpawnSpec,
  startSessionDaemon,
  stopSessionDaemon,
} from '../lib/session-daemon.mjs';

test('session pid file lives next to status.json', () => {
  assert.equal(
    sessionDaemonPidFile({ state: '/tmp/whatseal-state/alpha' }),
    '/tmp/whatseal-state/alpha/daemon.pid',
  );
});

test('session spawn spec is detached daemon.mjs with WHATSEAL_SESSION=1', () => {
  const spec = sessionDaemonSpawnSpec({
    execPath: '/usr/bin/node',
    projectRoot: '/tmp/whatseal-mcp',
    accountId: 'alpha',
    env: { PATH: '/usr/bin', HOME: '/tmp/whatseal-home' },
  });
  assert.equal(spec.command, '/usr/bin/node');
  assert.deepEqual(spec.args, [path.join('/tmp/whatseal-mcp', 'daemon.mjs'), '--account', 'alpha']);
  assert.equal(spec.options.cwd, '/tmp/whatseal-mcp');
  assert.equal(spec.options.detached, true);
  assert.deepEqual(spec.options.stdio, 'ignore');
  assert.equal(spec.options.windowsHide, true);
  assert.equal(spec.options.env.WHATSEAL_SESSION, '1');
  assert.equal(spec.options.env.WHATSAPP_ACCOUNT_ID, 'alpha');
  assert.equal(spec.options.env.PATH, '/usr/bin');
});

test('session spawn spec omits --account when using the default account', () => {
  const spec = sessionDaemonSpawnSpec({
    execPath: '/usr/bin/node',
    projectRoot: '/tmp/whatseal-mcp',
    accountId: null,
    env: {},
  });
  assert.deepEqual(spec.args, [path.join('/tmp/whatseal-mcp', 'daemon.mjs')]);
  assert.equal(spec.options.env.WHATSAPP_ACCOUNT_ID, undefined);
});

test('LaunchAgent lock-resume still exits; session daemons resume in-process', () => {
  assert.equal(shouldExitProcessOnLockResume({}), true);
  assert.equal(shouldExitProcessOnLockResume({ WHATSEAL_SESSION: '0' }), true);
  assert.equal(shouldExitProcessOnLockResume({ WHATSEAL_SESSION: '1' }), false);
});

test('startSessionDaemon is a no-op when the control socket is already live', async () => {
  const result = await startSessionDaemon({
    projectRoot: '/tmp/whatseal-mcp',
    accountId: 'alpha',
    paths: { socket: '/tmp/x.sock', state: '/tmp/x', logDir: '/tmp/x/logs' },
    controlSocketIsActiveImpl: async () => true,
    spawnImpl: () => {
      throw new Error('should not spawn');
    },
  });
  assert.deepEqual(result, { alreadyRunning: true, started: false, pid: null });
});

test('startSessionDaemon spawns a detached session daemon and writes a pid file', async () => {
  let spawned = null;
  const written = [];
  let probes = 0;
  const opened = [];
  const closed = [];
  const result = await startSessionDaemon({
    execPath: '/usr/bin/node',
    projectRoot: '/tmp/whatseal-mcp',
    accountId: 'alpha',
    env: { PATH: '/usr/bin' },
    paths: { socket: '/tmp/x.sock', state: '/tmp/x', logDir: '/tmp/x/logs' },
    controlSocketIsActiveImpl: async () => {
      probes += 1;
      return Boolean(spawned);
    },
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options };
      return { pid: 4242, unref() {} };
    },
    writeFileImpl: async (file, contents, options) => {
      written.push({ file, contents, options });
    },
    mkdirImpl: async () => {},
    accessImpl: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    rmImpl: async () => {},
    openSyncImpl: (file, flags) => {
      opened.push({ file, flags });
      return opened.length;
    },
    closeSyncImpl: (fd) => {
      closed.push(fd);
    },
  });
  assert.equal(result.started, true);
  assert.equal(result.alreadyRunning, false);
  assert.equal(result.pid, 4242);
  assert.equal(spawned.command, '/usr/bin/node');
  assert.equal(spawned.args.at(-1), 'alpha');
  assert.equal(spawned.options.detached, true);
  assert.deepEqual(spawned.options.stdio, ['ignore', 1, 2]);
  assert.equal(spawned.options.env.WHATSEAL_SESSION, '1');
  assert.deepEqual(
    sessionDaemonLogFiles({ logDir: '/tmp/x/logs' }),
    {
      stdout: '/tmp/x/logs/session-daemon.out.log',
      stderr: '/tmp/x/logs/session-daemon.err.log',
    },
  );
  assert.deepEqual(opened.map((entry) => entry.file), [
    '/tmp/x/logs/session-daemon.out.log',
    '/tmp/x/logs/session-daemon.err.log',
  ]);
  assert.deepEqual(closed, [1, 2]);
  const pidWrite = written.find((entry) => entry.file === '/tmp/x/daemon.pid');
  assert.equal(pidWrite.contents, '4242\n');
  assert.equal(pidWrite.options.mode, 0o600);
  assert.ok(written.some((entry) => entry.file === '/tmp/x/daemon.lock' && entry.options?.flag === 'wx'));
  assert.ok(probes >= 1);
});

test('startSessionDaemon refuses a LaunchAgent-owned account', async () => {
  await assert.rejects(
    () => startSessionDaemon({
      projectRoot: '/tmp/whatseal-mcp',
      accountId: 'alpha',
      paths: { socket: '/tmp/x.sock', state: '/tmp/x', logDir: '/tmp/x/logs' },
      controlSocketIsActiveImpl: async () => false,
      accessImpl: async () => {},
      spawnImpl: () => {
        throw new Error('should not spawn');
      },
    }),
    /LaunchAgent owns this account/i,
  );
});

test('startSessionDaemon fails closed when another start holds the lock', async () => {
  const lockError = Object.assign(new Error('exists'), { code: 'EEXIST' });
  let writes = 0;
  await assert.rejects(
    () => startSessionDaemon({
      projectRoot: '/tmp/whatseal-mcp',
      accountId: 'alpha',
      paths: { socket: '/tmp/x.sock', state: '/tmp/x', logDir: '/tmp/x/logs' },
      controlSocketIsActiveImpl: async () => false,
      accessImpl: async () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
      writeFileImpl: async (file) => {
        writes += 1;
        if (String(file).endsWith('daemon.lock')) throw lockError;
      },
      readFileImpl: async () => '99\n',
      killImpl: () => {},
      spawnImpl: () => {
        throw new Error('should not spawn');
      },
    }),
    /already in progress \(pid 99\)/i,
  );
  assert.equal(writes, 1);
});

test('startSessionDaemon fails closed when the child exits before the socket is up', async () => {
  await assert.rejects(
    () => startSessionDaemon({
      projectRoot: '/tmp/whatseal-mcp',
      accountId: 'alpha',
      paths: { socket: '/tmp/x.sock', state: '/tmp/x', logDir: '/tmp/x/logs' },
      controlSocketIsActiveImpl: async () => false,
      spawnImpl: () => {
        const child = {
          pid: 7,
          unref() {},
          once(event, handler) {
            if (event === 'exit') handler(1, null);
            return child;
          },
        };
        return child;
      },
      writeFileImpl: async () => {},
      mkdirImpl: async () => {},
      accessImpl: async () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
      openSyncImpl: () => 11,
      closeSyncImpl: () => {},
      waitTimeoutMs: 20,
      waitIntervalMs: 5,
    }),
    /exited before the control socket was ready/i,
  );
});

test('stopSessionDaemon is a no-op when the socket is already down', async () => {
  const result = await stopSessionDaemon({
    paths: { socket: '/tmp/x.sock', state: '/tmp/x' },
    controlSocketIsActiveImpl: async () => false,
    killImpl: () => {
      throw new Error('should not kill');
    },
  });
  assert.deepEqual(result, { stopped: false, alreadyStopped: true, pid: null });
});

test('stopSessionDaemon sends SIGTERM to the pid file and waits for the socket', async () => {
  const killed = [];
  let socketAlive = true;
  const result = await stopSessionDaemon({
    paths: { socket: '/tmp/x.sock', state: '/tmp/x' },
    controlSocketIsActiveImpl: async () => socketAlive,
    readFileImpl: async () => '4242\n',
    killImpl: (pid, signal) => {
      killed.push({ pid, signal });
      socketAlive = false;
    },
    rmImpl: async () => {},
    waitTimeoutMs: 200,
    waitIntervalMs: 5,
  });
  assert.equal(result.stopped, true);
  assert.equal(result.pid, 4242);
  assert.deepEqual(killed, [{ pid: 4242, signal: 'SIGTERM' }]);
});
