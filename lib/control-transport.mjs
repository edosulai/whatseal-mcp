import { chmod, lstat, rm } from 'node:fs/promises';
import net from 'node:net';

import {
  CONTROL_SOCKET_MODE,
  formatMode,
  normalizePlatform,
  supportsPosixModes,
  usesFilesystemControlSocket,
} from './platform.mjs';

export function createControlConnection(socketPath, connectImpl = net.createConnection) {
  return connectImpl(socketPath);
}

export async function removeStaleControlSocket(socketPath, {
  platform = process.platform,
  rmImpl = rm,
} = {}) {
  if (!usesFilesystemControlSocket(platform)) return false;
  await rmImpl(socketPath, { force: true });
  return true;
}

export async function listenControlSocket(server, socketPath, {
  platform = process.platform,
  chmodImpl = chmod,
} = {}) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  if (supportsPosixModes(platform)) {
    await chmodImpl(socketPath, CONTROL_SOCKET_MODE);
  }
  return socketPath;
}

export function assertPrivateControlSocket(metadata, {
  platform = process.platform,
} = {}) {
  if (!usesFilesystemControlSocket(platform)) return true;
  if (!metadata?.isSocket?.()) {
    throw new Error('Control transport is not a Unix-domain socket.');
  }
  const actualMode = formatMode(metadata);
  const expected = CONTROL_SOCKET_MODE.toString(8).padStart(4, '0');
  if (actualMode !== expected) {
    throw new Error(`Private socket mode is ${actualMode}, expected ${expected}.`);
  }
  return true;
}

export async function controlSocketIsActive(socketPath, {
  platform = process.platform,
  lstatImpl = lstat,
  createConnectionImpl = net.createConnection,
} = {}) {
  if (usesFilesystemControlSocket(platform)) {
    try {
      const stat = await lstatImpl(socketPath);
      if (!stat.isSocket()) throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  return await new Promise((resolve) => {
    const probe = createConnectionImpl(socketPath);
    const finish = (active) => {
      probe.destroy();
      resolve(active);
    };
    probe.once('connect', () => finish(true));
    probe.once('error', () => finish(false));
  });
}

export function describeControlTransport(platform = process.platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === 'win32') {
    return {
      platform: normalized,
      kind: 'named-pipe',
      filesystemSocket: false,
      mode: null,
    };
  }
  return {
    platform: normalized,
    kind: 'unix-socket',
    filesystemSocket: true,
    mode: CONTROL_SOCKET_MODE,
  };
}
