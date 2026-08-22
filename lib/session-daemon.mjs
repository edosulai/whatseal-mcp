import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { controlSocketIsActive } from './control-transport.mjs';
import { assertFilesystemControlSocketPath } from './platform.mjs';

export function sessionDaemonPidFile(paths) {
  return path.join(paths.state, 'daemon.pid');
}

export function sessionDaemonLockFile(paths) {
  return path.join(paths.state, 'daemon.lock');
}

export function sessionLaunchAgentMarker(paths) {
  return path.join(paths.state, 'launchagent-owned');
}

export function sessionDaemonLogFiles(paths) {
  return {
    stdout: path.join(paths.logDir, 'session-daemon.out.log'),
    stderr: path.join(paths.logDir, 'session-daemon.err.log'),
  };
}

export function isProcessAlive(pid, killImpl = (id, signal) => process.kill(id, signal)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function readPidFile(file, readFileImpl) {
  try {
    const pid = Number.parseInt(String(await readFileImpl(file, 'utf8')).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function assertNoLaunchAgentCollision(paths, {
  accessImpl = access,
} = {}) {
  const marker = sessionLaunchAgentMarker(paths);
  try {
    await accessImpl(marker);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  throw new Error(
    'A LaunchAgent owns this account (launchagent-owned). Use install-launchagent.sh start/stop/restart — do not spawn a session daemon on top of it.',
  );
}

export async function acquireSessionStartLock(paths, {
  pid = process.pid,
  writeFileImpl = writeFile,
  readFileImpl = readFile,
  rmImpl = rm,
  killImpl = (id, signal) => process.kill(id, signal),
} = {}) {
  const lockFile = sessionDaemonLockFile(paths);
  const tryCreate = async () => {
    await writeFileImpl(lockFile, `${pid}\n`, { flag: 'wx', mode: 0o600 });
    return { acquired: true, lockFile, stale: false };
  };

  try {
    return await tryCreate();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const existingPid = await readPidFile(lockFile, readFileImpl);
  if (existingPid && isProcessAlive(existingPid, killImpl)) {
    throw new Error(`Another whatseal start is already in progress (pid ${existingPid}).`);
  }
  await rmImpl(lockFile, { force: true }).catch(() => {});
  const retry = await tryCreate();
  return { ...retry, stale: true };
}

export function sessionDaemonSpawnSpec({
  execPath = process.execPath,
  projectRoot,
  accountId = null,
  env = process.env,
  stdio = 'ignore',
} = {}) {
  const args = [path.join(projectRoot, 'daemon.mjs')];
  if (accountId) args.push('--account', String(accountId));
  const nextEnv = { ...env, WHATSEAL_SESSION: '1' };
  if (accountId) nextEnv.WHATSAPP_ACCOUNT_ID = String(accountId);
  else delete nextEnv.WHATSAPP_ACCOUNT_ID;
  return {
    command: execPath,
    args,
    options: {
      cwd: projectRoot,
      detached: true,
      stdio,
      windowsHide: true,
      env: nextEnv,
    },
  };
}

async function waitFor(probe, {
  timeoutMs = 15_000,
  intervalMs = 50,
  message = 'condition was not met',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return true;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

export async function startSessionDaemon({
  execPath = process.execPath,
  projectRoot,
  accountId = null,
  env = process.env,
  paths,
  controlSocketIsActiveImpl = controlSocketIsActive,
  spawnImpl = spawn,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  readFileImpl = readFile,
  rmImpl = rm,
  accessImpl = access,
  openSyncImpl = openSync,
  closeSyncImpl = closeSync,
  killImpl = (id, signal) => process.kill(id, signal),
  waitTimeoutMs = 15_000,
  waitIntervalMs = 50,
} = {}) {
  if (await controlSocketIsActiveImpl(paths.socket)) {
    return { alreadyRunning: true, started: false, pid: null };
  }

  await assertNoLaunchAgentCollision(paths, { accessImpl });
  assertFilesystemControlSocketPath(paths.socket);

  await mkdirImpl(paths.state, { recursive: true, mode: 0o700 });
  await mkdirImpl(paths.logDir, { recursive: true, mode: 0o700 });

  const lock = await acquireSessionStartLock(paths, {
    writeFileImpl,
    readFileImpl,
    rmImpl,
    killImpl,
  });
  const releaseLock = async () => {
    await rmImpl(lock.lockFile, { force: true }).catch(() => {});
  };

  try {
    if (await controlSocketIsActiveImpl(paths.socket)) {
      await releaseLock();
      return { alreadyRunning: true, started: false, pid: null };
    }

    const logs = sessionDaemonLogFiles(paths);
    const outFd = openSyncImpl(logs.stdout, 'a');
    const errFd = openSyncImpl(logs.stderr, 'a');
    let child;
    try {
      const spec = sessionDaemonSpawnSpec({
        execPath,
        projectRoot,
        accountId,
        env,
        stdio: ['ignore', outFd, errFd],
      });
      child = spawnImpl(spec.command, spec.args, spec.options);
    } finally {
      closeSyncImpl(outFd);
      closeSyncImpl(errFd);
    }
    child.unref?.();

    let exited = false;
    let exitCode = null;
    let exitSignal = null;
    child.once?.('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
    });
    child.once?.('error', () => {
      exited = true;
    });

    if (child.pid) {
      await writeFileImpl(sessionDaemonPidFile(paths), `${child.pid}\n`, { mode: 0o600 });
    }

    await waitFor(async () => {
      if (exited) {
        throw new Error(
          `WhatsApp session daemon exited before the control socket was ready (code=${exitCode}, signal=${exitSignal}). See ${sessionDaemonLogFiles(paths).stderr}`,
        );
      }
      return controlSocketIsActiveImpl(paths.socket);
    }, {
      timeoutMs: waitTimeoutMs,
      intervalMs: waitIntervalMs,
      message: 'WhatsApp session daemon did not become ready (control socket still missing)',
    });

    await releaseLock();
    return { alreadyRunning: false, started: true, pid: child.pid ?? null };
  } catch (error) {
    await releaseLock();
    throw error;
  }
}

export async function stopSessionDaemon({
  paths,
  controlSocketIsActiveImpl = controlSocketIsActive,
  readFileImpl = readFile,
  killImpl = (pid, signal) => process.kill(pid, signal),
  rmImpl = rm,
  waitTimeoutMs = 10_000,
  waitIntervalMs = 50,
} = {}) {
  if (!(await controlSocketIsActiveImpl(paths.socket))) {
    await rmImpl(sessionDaemonPidFile(paths), { force: true }).catch(() => {});
    await rmImpl(sessionDaemonLockFile(paths), { force: true }).catch(() => {});
    return { stopped: false, alreadyStopped: true, pid: null };
  }

  const pidFile = sessionDaemonPidFile(paths);
  const pid = await readPidFile(pidFile, readFileImpl);
  if (!pid) {
    throw new Error(
      'Control socket is up but this is not a session daemon (no daemon.pid). Use install-launchagent.sh stop if a LaunchAgent was installed.',
    );
  }

  try {
    killImpl(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }

  await waitFor(async () => !(await controlSocketIsActiveImpl(paths.socket)), {
    timeoutMs: waitTimeoutMs,
    intervalMs: waitIntervalMs,
    message: `WhatsApp session daemon pid ${pid} did not stop`,
  });
  await rmImpl(pidFile, { force: true }).catch(() => {});
  await rmImpl(sessionDaemonLockFile(paths), { force: true }).catch(() => {});
  return { stopped: true, alreadyStopped: false, pid };
}
