import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ROOT = path.join(os.homedir(), '.local', 'share', 'whatsapp-agent');
const DEFAULT_STATE = path.join(os.homedir(), '.local', 'state', 'whatsapp-agent');

export const paths = Object.freeze({
  root: process.env.WHATSAPP_AGENT_ROOT || DEFAULT_ROOT,
  state: process.env.WHATSAPP_AGENT_STATE || DEFAULT_STATE,
  auth: path.join(process.env.WHATSAPP_AGENT_ROOT || DEFAULT_ROOT, 'auth'),
  socket: path.join(process.env.WHATSAPP_AGENT_STATE || DEFAULT_STATE, 'control.sock'),
  stateFile: path.join(process.env.WHATSAPP_AGENT_STATE || DEFAULT_STATE, 'status.json'),
  qrFile: path.join(process.env.WHATSAPP_AGENT_STATE || DEFAULT_STATE, 'pairing-qr.png'),
  logDir: path.join(process.env.WHATSAPP_AGENT_STATE || DEFAULT_STATE, 'logs'),
  sendLedger: path.join(process.env.WHATSAPP_AGENT_STATE || DEFAULT_STATE, 'send-ledger.json'),
  compatibilitySnapshot: path.join(process.env.WHATSAPP_AGENT_STATE || DEFAULT_STATE, 'compatibility-snapshot.json'),
  compatibilityBaseline: path.join(process.env.WHATSAPP_AGENT_STATE || DEFAULT_STATE, 'compatibility-baseline.json'),
});

export async function ensurePrivateDirectories() {
  for (const directory of [paths.root, paths.state, paths.auth, paths.logDir]) {
    try {
      const existing = await lstat(directory);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error(`Private path is not a real directory: ${directory}`);
      }
      if (existing.uid !== process.getuid()) {
        throw new Error(`Private path is not owned by the current user: ${directory}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    await chmod(directory, 0o700);
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

export async function writeFileAtomic(file, value, mode = 0o600) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(temporary, flags, mode);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid() || metadata.nlink !== 1) {
      throw new Error(`Unsafe temporary file metadata for ${file}`);
    }
    await handle.chmod(mode);
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

export function serializeMessage(message) {
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
    hasQuotedMessage: Boolean(message.hasQuotedMsg),
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

export function rpcCall(method, params = {}, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = JSON.stringify({ id: randomUUID(), method, params });
    const socket = net.createConnection(paths.socket);
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