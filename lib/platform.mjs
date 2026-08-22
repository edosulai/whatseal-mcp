import { createHash } from 'node:crypto';
import { existsSync as fsExistsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const APPROVAL_HELPER_MODE = 0o500;
export const CONTROL_SOCKET_MODE = 0o600;

export function normalizePlatform(platform = process.platform) {
  const value = String(platform || '').trim().toLowerCase();
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value;
  if (value.startsWith('win')) return 'win32';
  return value || 'unknown';
}

export function supportsPosixModes(platform = process.platform) {
  const normalized = normalizePlatform(platform);
  return normalized === 'darwin' || normalized === 'linux';
}

export function usesFilesystemControlSocket(platform = process.platform) {
  return normalizePlatform(platform) !== 'win32';
}

export function currentOwnerId({ processRef = process } = {}) {
  return typeof processRef.getuid === 'function' ? processRef.getuid() : null;
}

export function metadataOwnedByCurrentUser(metadata, { processRef = process } = {}) {
  const ownerId = currentOwnerId({ processRef });
  if (ownerId == null) return true;
  return metadata?.uid === ownerId;
}

export function formatMode(metadata) {
  return ((metadata?.mode || 0) & 0o777).toString(8).padStart(4, '0');
}

export function defaultAccountRoots({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  const normalized = normalizePlatform(platform);
  if (normalized === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
    return {
      root: path.join(localAppData, 'whatsapp-agent', 'data'),
      state: path.join(localAppData, 'whatsapp-agent', 'state'),
    };
  }
  if (normalized === 'linux') {
    const dataHome = env.XDG_DATA_HOME || path.join(homedir, '.local', 'share');
    const stateHome = env.XDG_STATE_HOME || path.join(homedir, '.local', 'state');
    return {
      root: path.join(dataHome, 'whatsapp-agent'),
      state: path.join(stateHome, 'whatsapp-agent'),
    };
  }
  return {
    root: path.join(homedir, '.local', 'share', 'whatsapp-agent'),
    state: path.join(homedir, '.local', 'state', 'whatsapp-agent'),
  };
}

export function controlTransportAddress(stateDir, {
  platform = process.platform,
  env = process.env,
} = {}) {
  if (!usesFilesystemControlSocket(platform)) {
    const digest = createHash('sha256').update(String(stateDir || '')).digest('hex').slice(0, 16);
    const user = String(env.USERNAME || env.USER || 'user').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 24) || 'user';
    return `\\\\.\\pipe\\whatsapp-agent-${user}-${digest}`;
  }
  return path.join(stateDir, 'control.sock');
}

/** sockaddr_un.sun_path capacity minus the trailing NUL. */
export function maxFilesystemControlSocketPathBytes(platform = process.platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === 'darwin') return 103;
  if (normalized === 'linux') return 107;
  return null;
}

export function assertFilesystemControlSocketPath(socketPath, {
  platform = process.platform,
} = {}) {
  if (!usesFilesystemControlSocket(platform)) return String(socketPath || '');
  const value = String(socketPath || '');
  if (!value) throw new Error('Control socket path is empty.');
  const max = maxFilesystemControlSocketPathBytes(platform);
  const bytes = Buffer.byteLength(value);
  if (max != null && bytes > max) {
    throw new Error(
      `Control socket path is ${bytes} bytes; ${normalizePlatform(platform)} AF_UNIX limit is ${max}. Use a shorter WHATSAPP_AGENT_STATE.`,
    );
  }
  return value;
}

export function messageApprovalHelperPath(stateDir, env = process.env) {
  return env.WHATSAPP_APPROVAL_HELPER || path.join(stateDir, 'native-approval');
}

export function baselineApprovalHelperPath(stateDir, env = process.env) {
  return env.WHATSAPP_BASELINE_APPROVAL_HELPER || path.join(stateDir, 'native-baseline-approval');
}

export function resolveAccountLayout({
  accountId = null,
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  const defaults = defaultAccountRoots({ platform, env, homedir });
  const baseRoot = env.WHATSAPP_AGENT_ROOT || defaults.root;
  const baseState = env.WHATSAPP_AGENT_STATE || defaults.state;
  const root = accountId ? path.join(baseRoot, accountId) : baseRoot;
  const state = accountId ? path.join(baseState, accountId) : baseState;
  return {
    root,
    state,
    auth: path.join(root, 'auth'),
    socket: controlTransportAddress(state, { platform, env }),
    stateFile: path.join(state, 'status.json'),
    secretsFile: path.join(state, 'secrets.json'),
    qrFile: path.join(state, 'pairing-qr.png'),
    logDir: path.join(state, 'logs'),
    sendLedger: path.join(state, 'send-ledger.json'),
    compatibilitySnapshot: path.join(state, 'compatibility-snapshot.json'),
    compatibilityBaseline: path.join(state, 'compatibility-baseline.json'),
    messageApprovalHelper: messageApprovalHelperPath(state, env),
    baselineApprovalHelper: baselineApprovalHelperPath(state, env),
    platform: normalizePlatform(platform),
  };
}

export function accountPaths(accountId = null, options = {}) {
  return Object.freeze(resolveAccountLayout({ accountId, ...options }));
}

export function resolveAccountsFile({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
  projectRoot = null,
  existsSync = fsExistsSync,
} = {}) {
  if (env?.WHATSEAL_ACCOUNTS) return env.WHATSEAL_ACCOUNTS;
  if (projectRoot) {
    const checkout = path.join(projectRoot, 'accounts.json');
    if (existsSync(checkout)) return checkout;
  }
  const defaults = defaultAccountRoots({ platform, env, homedir });
  return path.join(defaults.state, 'accounts.json');
}

const DARWIN_CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const LINUX_CHROME_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

const WIN32_CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

export function defaultChromeCandidates(platform = process.platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === 'darwin') return DARWIN_CHROME_CANDIDATES;
  if (normalized === 'linux') return LINUX_CHROME_CANDIDATES;
  if (normalized === 'win32') return WIN32_CHROME_CANDIDATES;
  return [];
}

export async function resolveChromePath({
  env = process.env,
  executablePath = null,
  platform = process.platform,
  existsSync = fsExistsSync,
} = {}) {
  if (env.WHATSAPP_CHROME_PATH) return env.WHATSAPP_CHROME_PATH;
  if (typeof executablePath === 'function') return await executablePath();
  for (const candidate of defaultChromeCandidates(platform)) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Chrome executable path is unavailable. Install Google Chrome or set WHATSAPP_CHROME_PATH.',
  );
}

export function describeLockPowerSupport(platform = process.platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === 'darwin') {
    return { platform: normalized, supported: true, reason: null };
  }
  return {
    platform: normalized,
    supported: false,
    reason: `Lock/lid probes are Darwin-only. ${normalized} degrades safe and does not pause.`,
  };
}

export function describeInstallSupport(platform = process.platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === 'darwin') {
    return {
      platform: normalized,
      supported: true,
      kind: 'launchagent',
      script: 'install-launchagent.sh',
      reason: null,
    };
  }
  if (normalized === 'linux') {
    return {
      platform: normalized,
      supported: false,
      kind: 'systemd-user',
      script: null,
      reason: 'Linux systemd user-unit install is not shipped. Darwin keeps LaunchAgent. Sealed send remains fail-closed on Linux.',
    };
  }
  return {
    platform: normalized,
    supported: false,
    kind: 'windows-service',
    script: null,
    reason: 'Windows service install is not shipped. Darwin keeps LaunchAgent. Sealed send remains fail-closed on Windows.',
  };
}

export function pathSecurityPassed({
  typeOk,
  metadata,
  expectedMode,
  platform = process.platform,
  processRef = process,
} = {}) {
  const owned = metadataOwnedByCurrentUser(metadata, { processRef });
  if (!typeOk || !owned) return false;
  if (!supportsPosixModes(platform)) return true;
  return formatMode(metadata) === expectedMode;
}
