import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';

import {
  currentOwnerId,
  normalizePlatform,
  supportsPosixModes,
} from './platform.mjs';

export function describeApprovalCapability(platform = process.platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === 'darwin') {
    return {
      platform: normalized,
      supported: true,
      kind: 'local-authentication',
      reason: null,
    };
  }
  return {
    platform: normalized,
    supported: false,
    kind: 'unavailable',
    reason: `Sealed send/approval is not implemented on ${normalized}. Darwin keeps Touch ID or the login password. Windows Hello and Linux polkit adapters are not shipped; refusing rather than silently approving.`,
  };
}

export async function assertSafeApprovalHelper(helperPath, {
  lstatImpl = lstat,
  processRef = process,
  platform = process.platform,
} = {}) {
  const helper = await lstatImpl(helperPath);
  const ownerId = currentOwnerId({ processRef });
  if (helper.isSymbolicLink() || !helper.isFile() || (ownerId != null && helper.uid !== ownerId)) {
    throw new Error('Native approval helper failed ownership or file-type validation.');
  }
  if (supportsPosixModes(platform) && (helper.mode & 0o022) !== 0) {
    throw new Error('Native approval helper must not be group- or world-writable.');
  }
  return helper;
}

export function spawnApprovalHelper(helperPath, payload, {
  spawnImpl = spawn,
  truncate = (value, maximum = 300) => String(value || '').slice(0, maximum),
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(helperPath, [], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(true);
      else if (code === 2) resolve(false);
      else reject(new Error(`Native approval failed with exit ${code}: ${truncate(stderr, 300)}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function requestNativeApproval(payload, {
  helperPath,
  platform = process.platform,
  lstatImpl = lstat,
  processRef = process,
  spawnImpl = spawn,
  truncate,
} = {}) {
  const capability = describeApprovalCapability(platform);
  if (!capability.supported) {
    throw new Error(capability.reason);
  }
  if (!helperPath) {
    throw new Error('Native approval helper path is missing.');
  }
  await assertSafeApprovalHelper(helperPath, { lstatImpl, processRef, platform });
  return spawnApprovalHelper(helperPath, payload, { spawnImpl, truncate });
}
