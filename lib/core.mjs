import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

import { isIdleColdPhase } from './browser-lifecycle.mjs';
import { createControlConnection } from './control-transport.mjs';
import {
  describeInstallSupport,
  DIRECTORY_MODE,
  metadataOwnedByCurrentUser,
  PRIVATE_FILE_MODE,
  resolveAccountLayout,
  supportsPosixModes,
} from './platform.mjs';

export function accountPaths(accountId = null, options = {}) {
  return Object.freeze(resolveAccountLayout({ accountId, ...options }));
}

// Legacy single-account paths (used when WHATSAPP_ACCOUNT_ID is not set)
export const paths = accountPaths(process.env.WHATSAPP_ACCOUNT_ID || null);

export async function ensurePrivateDirectories(targetPaths = paths) {
  for (const directory of [targetPaths.root, targetPaths.state, targetPaths.auth, targetPaths.logDir]) {
    try {
      const existing = await lstat(directory);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error(`Private path is not a real directory: ${directory}`);
      }
      if (!metadataOwnedByCurrentUser(existing)) {
        throw new Error(`Private path is not owned by the current user: ${directory}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    }
    if (supportsPosixModes()) {
      await chmod(directory, DIRECTORY_MODE);
    }
  }
}

export function parseCommonArgs(argv) {
  const verbose = argv.includes('--verbose') || argv.includes('-v');
  const help = argv.includes('--help') || argv.includes('-h');
  return { verbose, help };
}

export function createLogger(name, verbose = false) {
  const emit = (level, event, detail = '') => {
    const fields = [
      new Date().toISOString(),
      `script=${name}`,
      `pid=${process.pid}`,
      `level=${level}`,
      `event=${event}`,
    ];
    if (detail) fields.push(`detail=${String(detail).replace(/[\r\n]+/g, ' ')}`);
    process.stderr.write(`${fields.join(' ')}\n`);
  };
  return {
    info: (event, detail) => emit('info', event, detail),
    error: (event, detail) => emit('error', event, detail),
    debug: (event, detail) => {
      if (verbose) emit('debug', event, detail);
    },
  };
}

export async function writeFileAtomic(file, value, mode = PRIVATE_FILE_MODE) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(temporary, flags, mode);
  try {
    const metadata = await handle.stat();
    const nlinkOk = !supportsPosixModes() || metadata.nlink === 1;
    if (!metadata.isFile() || !metadataOwnedByCurrentUser(metadata) || !nlinkOk) {
      throw new Error(`Unsafe temporary file metadata for ${file}`);
    }
    if (supportsPosixModes()) {
      await handle.chmod(mode);
    }
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

export async function writeJsonAtomic(file, value, mode = 0o600) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function truncateText(value, maximum = 4000) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum)}…`;
}

export function serializeChat(chat, { includeLastMessage = false } = {}) {
  const last = chat.lastMessage;
  const result = {
    id: chat.id?._serialized || '',
    name: chat.name || '',
    isGroup: Boolean(chat.isGroup),
    unreadCount: Number(chat.unreadCount || 0),
    timestamp: Number(chat.timestamp || last?.timestamp || 0),
    archived: Boolean(chat.archived),
    pinned: Boolean(chat.pinned),
    muted: Boolean(chat.isMuted),
  };
  if (includeLastMessage) {
    result.lastMessage = last ? {
      fromMe: Boolean(last.fromMe),
      timestamp: Number(last.timestamp || 0),
      type: last.type || 'unknown',
      body: truncateText(last.body, 800),
      hasMedia: Boolean(last.hasMedia),
    } : null;
  }
  return result;
}

export function serializeQuotedMessage(quoted) {
  if (!quoted) return null;
  const id = typeof quoted.id === 'string'
    ? quoted.id
    : (quoted.id?._serialized || '');
  return {
    id,
    body: truncateText(quoted.body || quoted.caption || '', 400),
    type: quoted.type || 'unknown',
    fromMe: Boolean(quoted.fromMe ?? quoted.id?.fromMe),
  };
}

export function serializeMessage(message) {
  const quoted = message.quoted || message.quotedMsg || null;
  return {
    id: message.id?._serialized || '',
    chatId: message.id?.remote || message.from || '',
    fromMe: Boolean(message.fromMe),
    from: message.from || '',
    to: message.to || '',
    author: message.author || null,
    timestamp: Number(message.timestamp || 0),
    type: message.type || 'unknown',
    body: truncateText(message.body, 12000),
    hasMedia: Boolean(message.hasMedia),
    hasQuotedMessage: Boolean(message.hasQuotedMsg || message.hasQuotedMessage || quoted),
    quoted: serializeQuotedMessage(quoted),
  };
}

export function buildUnreadDigest(chats, {
  limit = 20,
  includePreview = true,
  since = 0,
  now = () => new Date().toISOString(),
} = {}) {
  const sinceTs = Number(since || 0);
  const list = Array.isArray(chats) ? chats : [];
  const unread = list
    .filter((chat) => Number(chat.unreadCount || 0) > 0)
    .filter((chat) => !sinceTs || Number(chat.timestamp || chat.lastMessage?.timestamp || 0) > sinceTs)
    .sort((a, b) => Number(b.timestamp || b.lastMessage?.timestamp || 0) - Number(a.timestamp || a.lastMessage?.timestamp || 0));
  const maximum = Math.min(Math.max(Number(limit || 20), 1), 200);
  const selected = unread.slice(0, maximum);
  const nextSince = unread.reduce((max, chat) => Math.max(max, Number(chat.timestamp || 0)), sinceTs);
  return {
    capturedAt: now(),
    markRead: false,
    since: sinceTs || null,
    nextSince,
    totalUnreadChats: unread.length,
    totalUnreadMessages: unread.reduce((sum, chat) => sum + Number(chat.unreadCount || 0), 0),
    truncated: unread.length > selected.length,
    chats: selected.map((chat) => {
      const item = {
        id: chat.id || '',
        name: chat.name || '',
        isGroup: Boolean(chat.isGroup),
        unreadCount: Number(chat.unreadCount || 0),
        timestamp: Number(chat.timestamp || 0),
        archived: Boolean(chat.archived),
        pinned: Boolean(chat.pinned),
        muted: Boolean(chat.muted),
      };
      if (includePreview) item.lastMessage = chat.lastMessage || null;
      return item;
    }),
  };
}

export class DraftStore {
  constructor({ ttlMs = 10 * 60 * 1000, maximum = 100, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maximum = maximum;
    this.now = now;
    this.drafts = new Map();
  }

  prepare({ chatId, chatName, text, action = 'send-text', payload = null }) {
    this.prune();
    if (this.drafts.size >= this.maximum) {
      throw new Error(`Too many pending drafts (${this.maximum}). Wait for them to expire or approve one.`);
    }
    const approvalId = randomUUID();
    const createdAt = this.now();
    const draft = {
      approvalId,
      chatId,
      chatName,
      text,
      action,
      payload: payload === null ? null : structuredClone(payload),
      state: 'prepared',
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.drafts.set(approvalId, draft);
    return structuredClone(draft);
  }

  beginApproval(approvalId) {
    this.prune();
    const draft = this.drafts.get(approvalId);
    if (!draft) throw new Error('Approval is missing or expired. Prepare the message again.');
    if (draft.state !== 'prepared') throw new Error(`Approval is already ${draft.state}.`);
    draft.state = 'awaiting-local-approval';
    return structuredClone(draft);
  }

  consumeApproved(approvalId) {
    const draft = this.drafts.get(approvalId);
    if (!draft || draft.state !== 'awaiting-local-approval') {
      throw new Error('Draft is not awaiting native user approval.');
    }
    this.drafts.delete(approvalId);
    return draft;
  }

  cancel(approvalId) {
    this.drafts.delete(approvalId);
  }

  prune() {
    const now = this.now();
    for (const [id, draft] of this.drafts.entries()) {
      if (draft.expiresAt <= now) this.drafts.delete(id);
    }
  }
}

/** Default client wait for WA RPCs. Must cover ensureReady (180s) after idle_cold. */
export const DEFAULT_RPC_TIMEOUT_MS = 180_000;

export function rpcCall(method, params = {}, { timeoutMs = DEFAULT_RPC_TIMEOUT_MS, socketPath = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = JSON.stringify({ id: randomUUID(), method, params });
    const socket = createControlConnection(socketPath || paths.socket);
    let buffer = '';
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error(`Backend request timed out after ${timeoutMs} ms.`)), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${request}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 10 * 1024 * 1024) {
        finish(new Error('Backend response exceeded the 10 MiB safety limit.'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response.ok) finish(new Error(response.error || 'Backend request failed.'));
        else finish(null, response.result);
      } catch (error) {
        finish(new Error(`Invalid backend response: ${error.message}`));
      }
    });
    socket.once('error', (error) => finish(new Error(`WhatsApp backend unavailable: ${error.message}`)));
    socket.once('end', () => {
      if (!settled) finish(new Error('WhatsApp backend closed the connection without a response.'));
    });
  });
}

export function resolveAccountRecord(config, accountParam = null) {
  const accounts = Array.isArray(config?.accounts) ? config.accounts : [];
  if (!accountParam) {
    const id = config?.default || accounts[0]?.id || null;
    if (!id) {
      return { id: null, record: null, paths: accountPaths(null) };
    }
    const record = accounts.find((entry) => entry.id === id) || { id, alias: id, description: '' };
    return { id, record, paths: accountPaths(id) };
  }

  const match = accounts.find((entry) => entry.id === accountParam || entry.alias === accountParam);
  if (!match) {
    const available = accounts.map((entry) => `${entry.id} (${entry.alias || entry.id})`).join(', ') || '(none)';
    const error = new Error(`Unknown account: ${accountParam}. Available: ${available}`);
    error.code = 'UNKNOWN_ACCOUNT';
    throw error;
  }
  return { id: match.id, record: match, paths: accountPaths(match.id) };
}

export function backendLifecycleCommands(accountId, projectRoot, { platform = process.platform } = {}) {
  const accountFlag = accountId ? ` --account ${accountId}` : '';
  const qrCli = accountId ? `node cli.mjs qr --account ${accountId}` : 'node cli.mjs qr';
  const start = accountId ? `node cli.mjs start --account ${accountId}` : 'node cli.mjs start';
  const stop = accountId ? `node cli.mjs stop --account ${accountId}` : 'node cli.mjs stop';
  const status = accountId ? `node cli.mjs status --account ${accountId}` : 'node cli.mjs status';
  const install = describeInstallSupport(platform);
  if (install.supported && install.script) {
    const script = path.join(projectRoot || process.cwd(), install.script);
    return {
      install: `${script} install${accountFlag}`,
      start,
      stop,
      status,
      restart: `${script} restart${accountFlag}`,
      qrCli,
    };
  }
  const reason = install.reason || `Background service install is not shipped on ${install.platform}.`;
  return {
    install: reason,
    start,
    stop,
    status,
    restart: reason,
    qrCli,
  };
}

function phaseCode(phase, { unavailable = false } = {}) {
  if (unavailable) return 'BACKEND_UNAVAILABLE';
  switch (phase) {
    case 'ready':
      return 'READY';
    case 'pairing':
      return 'NEEDS_PAIRING';
    case 'authenticated':
      return 'AUTHENTICATED_SYNCING';
    case 'starting':
    case 'opening':
    case 'OPENING':
    case 'resuming_after_lock':
      return 'STARTING';
    case 'idle_cold':
    case 'idle_no_browser':
      return 'IDLE_COLD';
    case 'paused_by_lock':
      return 'PAUSED_BY_LOCK';
    case 'auth-failure':
      return 'AUTH_FAILURE';
    case 'disconnected':
      return 'DISCONNECTED';
    case 'stopping':
    case 'stopped':
      return 'BACKEND_STOPPED';
    case 'failed':
      return 'BACKEND_FAILED';
    default:
      return phase ? 'NOT_READY' : 'BACKEND_STOPPED';
  }
}

export function buildReadinessGuidance({
  accountId = null,
  alias = null,
  phase = null,
  ready = false,
  qrAvailable = false,
  qrPath = null,
  code = null,
  projectRoot = process.cwd(),
  backendError = null,
} = {}) {
  const resolvedCode = code || phaseCode(phase, { unavailable: Boolean(backendError && !phase) });
  const label = alias && accountId ? `${alias} (${accountId})` : (accountId || 'default');
  const commands = backendLifecycleCommands(accountId, projectRoot);
  const agentNextSteps = [];
  const userSteps = [];
  let userMessage = '';

  if (ready || resolvedCode === 'READY') {
    return {
      code: 'READY',
      ready: true,
      phase: phase || 'ready',
      account: accountId,
      alias,
      userMessage: `WhatsApp backend is ready for ${label}.`,
      agentNextSteps: [
        'Proceed with read tools freely.',
        'For sends/reactions/mark-read: prepare → show exact preview → wait for explicit user OK → request_local_approval.',
        'On approval timeout, call whatsapp_send_outcome; do not re-prepare blindly.',
      ],
      userSteps: [],
      commands,
      qrAvailable: false,
      qrPath: null,
    };
  }

  if (resolvedCode === 'UNKNOWN_ACCOUNT') {
    userMessage = backendError || 'Unknown WhatsApp account.';
    agentNextSteps.push('Call whatsapp_list_accounts and use a valid id/alias.');
  } else if (resolvedCode === 'BACKEND_UNAVAILABLE' || resolvedCode === 'BACKEND_STOPPED') {
    userMessage = `WhatsApp backend is not running for ${label}. Linked-device credentials may still exist, but the daemon is stopped.`;
    agentNextSteps.push(
      'whatsapp_status / whatsapp_doctor / whatsapp_list_accounts never spawn. Tell the user the backend is stopped.',
      'If the user already asked to start, pair, or wait-ready: call whatsapp_wait_ready / whatsapp_qr / whatseal start (they spawn a session daemon). Do not wait for a second permission turn.',
      `Suggested command: ${commands.start}`,
      'Persistent login start remains opt-in via --install-agent. After start, poll whatsapp_status or whatsapp_wait_ready until ready=true or pairing is required.',
    );
    userSteps.push(
      { id: 'start', label: 'Start backend', command: commands.start },
      { id: 'install', label: 'Install + start backend', command: commands.install },
      { id: 'status', label: 'Check service status', command: commands.status },
    );
  } else if (resolvedCode === 'NEEDS_PAIRING') {
    userMessage = `WhatsApp account ${label} needs pairing. Scan the linked-device QR on your phone.`;
    agentNextSteps.push(
      'Call whatsapp_qr for the private QR PNG path.',
      'Show the path to the user and ask them to open the PNG locally (do not upload QR contents to chat if avoidable).',
      'Instruct: WhatsApp → Settings → Linked Devices → Link a Device → scan QR.',
      'Poll whatsapp_wait_ready / whatsapp_status until ready=true.',
    );
    userSteps.push(
      { id: 'open-qr', label: 'Open pairing QR', command: qrPath ? `open ${qrPath}` : commands.qrCli },
      { id: 'scan', label: 'On phone: WhatsApp → Settings → Linked Devices → Link a Device' },
    );
  } else if (resolvedCode === 'IDLE_COLD') {
    userMessage = `WhatsApp Chrome is idle for ${label} (phase=${phase}). The control socket is up; the next WhatsApp read wakes Chrome and can take up to ~3 minutes.`;
    agentNextSteps.push(
      'This is not a stopped backend. Do not start extra accounts or scan a new QR.',
      'Call whatsapp_wait_ready with timeoutSec=180, then retry the read tool.',
      'If wait_ready returns paused_by_lock, ask the user to unlock and open the lid.',
    );
    userSteps.push({ id: 'wait', label: 'Wait for WhatsApp Chrome to wake (up to ~3 minutes)' });
  } else if (resolvedCode === 'PAUSED_BY_LOCK') {
    userMessage = `WhatsApp backend for ${label} is paused_by_lock (screen locked or lid closed).`;
    agentNextSteps.push(
      'Ask the user to unlock the screen and open the lid.',
      'Then call whatsapp_wait_ready with timeoutSec=180. Do not start extra accounts.',
    );
    userSteps.push({ id: 'unlock', label: 'Unlock the Mac and open the lid' });
  } else if (resolvedCode === 'AUTHENTICATED_SYNCING' || resolvedCode === 'STARTING') {
    userMessage = `WhatsApp account ${label} is connected but not fully ready yet (phase=${phase}).`;
    agentNextSteps.push(
      'Tell the user to wait for Chrome wake / initial sync.',
      'Poll whatsapp_wait_ready for up to 180 seconds before declaring failure.',
    );
    userSteps.push({ id: 'wait', label: 'Wait for WhatsApp Web sync to finish' });
  } else if (resolvedCode === 'AUTH_FAILURE' || resolvedCode === 'DISCONNECTED') {
    userMessage = `WhatsApp account ${label} requires re-authentication (phase=${phase}).`;
    agentNextSteps.push(
      'Ask the user to restart the backend and re-pair if a QR appears.',
      `Restart command: ${commands.restart}`,
      'Use whatsapp_qr if phase becomes pairing.',
    );
    userSteps.push(
      { id: 'restart', label: 'Restart backend', command: commands.restart },
      { id: 'relink', label: 'Re-link device if QR appears' },
    );
  } else {
    userMessage = backendError
      || `WhatsApp backend is not ready for ${label} (phase=${phase || 'unknown'}).`;
    agentNextSteps.push(
      'Call whatsapp_doctor for a full diagnosis.',
      'Do not invent chat contents while the backend is unavailable.',
    );
    userSteps.push({ id: 'doctor', label: 'Run doctor via MCP tool whatsapp_doctor' });
  }

  return {
    code: resolvedCode,
    ready: false,
    phase: phase || (resolvedCode === 'BACKEND_UNAVAILABLE' ? 'stopped' : null),
    account: accountId,
    alias,
    userMessage,
    agentNextSteps,
    userSteps,
    commands,
    qrAvailable: Boolean(qrAvailable || (resolvedCode === 'NEEDS_PAIRING' && qrPath)),
    qrPath: qrPath || null,
    backendError: backendError || null,
  };
}

export function classifyRpcError(error, context = {}) {
  const message = error?.message || String(error);
  const accountId = context.accountId || null;
  const alias = context.alias || null;
  const projectRoot = context.projectRoot || process.cwd();
  const saved = context.savedState || {};

  if (error?.code === 'UNKNOWN_ACCOUNT' || message.startsWith('Unknown account:')) {
    return buildReadinessGuidance({
      accountId,
      alias,
      code: 'UNKNOWN_ACCOUNT',
      projectRoot,
      backendError: message,
    });
  }

  const notReadyMatch = message.match(/not ready \(phase=([^)]+)\)/i);
  if (notReadyMatch) {
    const phase = notReadyMatch[1];
    return buildReadinessGuidance({
      accountId,
      alias,
      phase,
      ready: false,
      qrAvailable: phase === 'pairing',
      qrPath: phase === 'pairing' ? (context.paths?.qrFile || saved.qrPath || null) : null,
      projectRoot,
      backendError: message,
    });
  }

  if (/paused_by_lock|screen locked or lid closed/i.test(message)) {
    return buildReadinessGuidance({
      accountId,
      alias,
      phase: 'paused_by_lock',
      ready: false,
      projectRoot,
      backendError: message,
    });
  }

  if (/unavailable|ENOENT|ECONNREFUSED|connect /i.test(message)) {
    return buildReadinessGuidance({
      accountId,
      alias,
      phase: saved.phase || 'stopped',
      ready: false,
      qrAvailable: Boolean(saved.qrAvailable),
      qrPath: saved.qrPath || null,
      code: 'BACKEND_UNAVAILABLE',
      projectRoot,
      backendError: message,
    });
  }

  if (/timed out|closed the connection without a response|wake timed out/i.test(message)) {
    const phase = context.phase || saved.phase || saved.lastKnownPhase || null;
    if (isIdleColdPhase(phase) || phase === 'starting' || phase === 'resuming_after_lock') {
      return buildReadinessGuidance({
        accountId,
        alias,
        phase,
        ready: false,
        projectRoot,
        backendError: message,
      });
    }
    return {
      ...buildReadinessGuidance({
        accountId,
        alias,
        phase,
        ready: false,
        projectRoot,
        backendError: message,
        code: 'BACKEND_TIMEOUT',
      }),
      code: 'BACKEND_TIMEOUT',
      userMessage: `WhatsApp backend timed out for ${alias && accountId ? `${alias} (${accountId})` : (accountId || 'default')}.`,
      agentNextSteps: [
        'Call whatsapp_status or whatsapp_doctor.',
        'If phase is idle_cold, call whatsapp_wait_ready with timeoutSec=180 then retry.',
        'If a send approval was in flight, call whatsapp_send_outcome before preparing again.',
      ],
    };
  }

  return buildReadinessGuidance({
    accountId,
    alias,
    phase: context.phase || saved.phase || null,
    ready: false,
    projectRoot,
    backendError: message,
    code: 'BACKEND_ERROR',
  });
}

export async function readAccountStatus({ accountId = null, pathsForAccount = null, timeoutMs = 3000 } = {}) {
  const resolvedPaths = pathsForAccount || accountPaths(accountId);
  const savedState = await readJson(resolvedPaths.stateFile, {});
  try {
    const live = await rpcCall('status', {}, { timeoutMs, socketPath: resolvedPaths.socket });
    return {
      source: 'live',
      ...live,
      ready: Boolean(live.ready),
      savedState,
    };
  } catch (error) {
    // Socket is down: never trust a stale ready/pairing phase from status.json.
    return {
      source: 'saved',
      ready: false,
      phase: 'stopped',
      connectionState: null,
      qrAvailable: false,
      qrPath: null,
      qrUpdatedAt: savedState.qrUpdatedAt || null,
      readyAt: savedState.readyAt || null,
      pid: null,
      updatedAt: savedState.updatedAt || null,
      lastKnownPhase: savedState.phase || null,
      lastKnownReady: Boolean(savedState.ready),
      savedState,
      error: error.message,
    };
  }
}