#!/usr/bin/env node
import process from 'node:process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  buildReadinessGuidance,
  classifyRpcError,
  createLogger,
  DEFAULT_RPC_TIMEOUT_MS,
  parseCommonArgs,
  readAccountStatus,
  readJson,
  resolveAccountRecord,
  rpcCall,
} from './lib/core.mjs';
import { isIdleColdPhase } from './lib/browser-lifecycle.mjs';
import { resolveAccountsFile } from './lib/platform.mjs';

const require = createRequire(import.meta.url);
const { verbose, help } = parseCommonArgs(process.argv.slice(2));
const log = createLogger('whatseal-mcp', verbose);
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = require('./package.json');

const MCP_INSTRUCTIONS = `whatseal-mcp — sealed WhatsApp for local AI agents.

Before ANY WhatsApp content or send action:
1. Call whatsapp_list_accounts or whatsapp_doctor (preferred first call in a new chat).
2. If ready=false, explain userMessage to the user and follow agentNextSteps. Do NOT invent chats/messages.
3. If code=IDLE_COLD: Chrome is down on purpose. Call whatsapp_wait_ready (timeoutSec=180) then retry the read. Do not start extra accounts or scan a QR.
4. If code=BACKEND_UNAVAILABLE or BACKEND_STOPPED: ask permission, then have the user run the provided start/install command (or confirm before any shell start).
5. If code=NEEDS_PAIRING: call whatsapp_qr, show the local PNG path, tell user to scan via WhatsApp → Settings → Linked Devices → Link a Device. Poll whatsapp_wait_ready.
6. Reads (list/read/search/unread_digest) never need Touch ID and never mark chats as seen. The first read after idle_cold wakes Chrome and can take up to ~3 minutes.
7. Sends/replies/reactions/mark-read are two-phase ONLY:
   prepare_* → show exact target+preview to the user → wait for explicit OK in chat → whatsapp_request_local_approval (Touch ID / macOS password).
   For quote-replies use whatsapp_prepare_reply with the exact message ID from read/search.
8. On approval timeout or uncertainty: whatsapp_send_outcome first; never re-prepare a duplicate send blindly.
9. Optional account param accepts id or alias from accounts.json. Omit account to use default.

Never claim a message was sent unless request_local_approval / send_outcome reports success.`;

if (help) {
  process.stdout.write('Usage: node mcp-server.mjs [--verbose|-v]\n\nRuns the local whatseal WhatsApp MCP bridge over stdio.\nSupports multiple accounts via the account parameter.\n');
  process.exit(0);
}

const accountsConfigPromise = readJson(resolveAccountsFile({ projectRoot: PROJECT_ROOT }), { accounts: [], default: null });
let accountsCache = null;

async function getAccounts() {
  if (accountsCache) return accountsCache;
  accountsCache = await accountsConfigPromise;
  return accountsCache;
}

async function resolveAccount(accountParam) {
  const config = await getAccounts();
  return resolveAccountRecord(config, accountParam || null);
}

async function routedRpcCall(method, params, { timeoutMs = DEFAULT_RPC_TIMEOUT_MS, account = null } = {}) {
  const { paths: accountPathSet } = await resolveAccount(account);
  return rpcCall(method, params, { timeoutMs, socketPath: accountPathSet.socket });
}

function response(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function failure(error, extras = {}) {
  const message = error?.message || String(error);
  log.error('tool-failed', message);
  const payload = extras && Object.keys(extras).length > 0
    ? { error: message, ...extras }
    : message;
  return {
    isError: true,
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
  };
}

async function failureFromRpc(error, accountParam = null) {
  try {
    const { id, record, paths: accountPathSet } = await resolveAccount(accountParam);
    const savedState = await readJson(accountPathSet.stateFile, {});
    const guidance = classifyRpcError(error, {
      accountId: id,
      alias: record?.alias || null,
      paths: accountPathSet,
      savedState,
      projectRoot: PROJECT_ROOT,
    });
    return failure(error, guidance);
  } catch (resolveError) {
    if (resolveError?.code === 'UNKNOWN_ACCOUNT' || /Unknown account:/.test(resolveError.message)) {
      const guidance = classifyRpcError(resolveError, { projectRoot: PROJECT_ROOT });
      return failure(resolveError, guidance);
    }
    return failure(error);
  }
}

function enrichStatus(accountMeta, status) {
  const guidance = buildReadinessGuidance({
    accountId: accountMeta.id,
    alias: accountMeta.record?.alias || null,
    phase: status.phase,
    ready: Boolean(status.ready),
    qrAvailable: Boolean(status.qrAvailable),
    qrPath: status.qrPath || null,
    projectRoot: PROJECT_ROOT,
    backendError: status.error || null,
    code: status.ready ? 'READY' : (status.error ? 'BACKEND_UNAVAILABLE' : null),
  });
  return {
    account: accountMeta.id,
    alias: accountMeta.record?.alias || null,
    description: accountMeta.record?.description || null,
    ...status,
    ...guidance,
    phase: status.phase || guidance.phase,
    ready: Boolean(status.ready),
    qrAvailable: Boolean(status.qrAvailable),
    qrPath: status.qrPath || guidance.qrPath || null,
  };
}

const server = new McpServer(
  { name: 'whatseal-mcp', version: PACKAGE.version || '2.0.0' },
  { instructions: MCP_INSTRUCTIONS },
);

function register(name, config, method, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
  const schema = {
    account: z.string().optional().describe('Account ID or alias. Omit to use the default account.'),
    ...config.inputSchema,
  };
  server.registerTool(name, { ...config, inputSchema: schema }, async (params) => {
    try {
      const { account, ...rest } = params;
      log.debug('tool-call', `${name} account=${account || 'default'}`);
      return response(await routedRpcCall(method, rest, { timeoutMs, account }));
    } catch (error) {
      return failureFromRpc(error, params?.account || null);
    }
  });
}

server.registerTool('whatsapp_list_accounts', {
  description: 'List all configured WhatsApp accounts with IDs, aliases, and connection status. Preferred discovery tool before using account-specific operations.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const config = await getAccounts();
    const statuses = await Promise.all(config.accounts.map(async (entry) => {
      const status = await readAccountStatus({ accountId: entry.id, timeoutMs: 3000 });
      const enriched = enrichStatus({ id: entry.id, record: entry }, status);
      return {
        id: entry.id,
        alias: entry.alias,
        description: entry.description,
        ready: enriched.ready,
        phase: enriched.phase,
        code: enriched.code,
        source: status.source,
        userMessage: enriched.userMessage,
      };
    }));
    return response({ default: config.default, accounts: statuses });
  } catch (error) {
    return failure(error);
  }
});

server.registerTool('whatsapp_status', {
  description: 'Check whether the private local WhatsApp linked-device backend is paired and ready. Returns structured guidance when the backend is stopped, pairing, or syncing. Does not read messages.',
  inputSchema: {
    account: z.string().optional().describe('Account ID or alias. Omit to use the default account.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ account } = {}) => {
  try {
    const accountMeta = await resolveAccount(account || null);
    const status = await readAccountStatus({
      accountId: accountMeta.id,
      pathsForAccount: accountMeta.paths,
      timeoutMs: 5000,
    });
    return response(enrichStatus(accountMeta, status));
  } catch (error) {
    return failureFromRpc(error, account || null);
  }
});

server.registerTool('whatsapp_doctor', {
  description: 'One-shot diagnosis for agents: configured accounts, backend readiness, pairing/QR hints, and exact next steps/commands. Call this first in a new chat when WhatsApp tools fail or status is unknown.',
  inputSchema: {
    account: z.string().optional().describe('Optional account to highlight. Omit to diagnose default + summarize all accounts.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ account } = {}) => {
  try {
    const config = await getAccounts();
    const catalog = config.accounts.length
      ? config.accounts
      : [{ id: null, alias: 'default', description: 'Legacy single-account' }];
    const all = await Promise.all(catalog.map(async (entry) => {
      const status = await readAccountStatus({ accountId: entry.id, timeoutMs: 3000 });
      return enrichStatus({ id: entry.id, record: entry }, status);
    }));

    const focusId = account
      ? (await resolveAccount(account)).id
      : (config.default || all[0]?.account || null);
    const focus = all.find((entry) => entry.account === focusId) || all[0] || null;

    return response({
      ok: Boolean(focus?.ready),
      default: config.default,
      focus,
      accounts: all.map((entry) => ({
        account: entry.account,
        alias: entry.alias,
        ready: entry.ready,
        phase: entry.phase,
        code: entry.code,
        source: entry.source,
        userMessage: entry.userMessage,
      })),
      agentNextSteps: focus?.agentNextSteps || ['Configure accounts.json and install the LaunchAgent.'],
      userSteps: focus?.userSteps || [],
      commands: focus?.commands || null,
      workflow: {
        firstCall: 'whatsapp_doctor or whatsapp_list_accounts',
        reads: 'whatsapp_list_chats / whatsapp_read_messages / whatsapp_search_messages',
        sends: 'prepare_* → show preview → user OK → whatsapp_request_local_approval',
        afterTimeout: 'whatsapp_send_outcome',
      },
    });
  } catch (error) {
    return failureFromRpc(error, account || null);
  }
});

server.registerTool('whatsapp_qr', {
  description: 'Return the private pairing QR PNG path and phone scan instructions when the backend is in pairing mode. Does not print QR pixels. If not pairing, returns structured next steps instead.',
  inputSchema: {
    account: z.string().optional().describe('Account ID or alias. Omit to use the default account.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ account } = {}) => {
  try {
    const accountMeta = await resolveAccount(account || null);
    const status = await readAccountStatus({
      accountId: accountMeta.id,
      pathsForAccount: accountMeta.paths,
      timeoutMs: 5000,
    });
    const enriched = enrichStatus(accountMeta, status);
    const qrPath = status.qrPath || accountMeta.paths.qrFile;
    let qrFilePresent = false;
    try {
      await access(qrPath);
      qrFilePresent = true;
    } catch {
      qrFilePresent = false;
    }

    const pairing = Boolean(status.qrAvailable || status.phase === 'pairing' || (qrFilePresent && !status.ready));
    if (!pairing) {
      return response({
        ...enriched,
        qrAvailable: false,
        qrPath: null,
        qrFilePresent,
        phoneSteps: [
          'WhatsApp → Settings → Linked Devices → Link a Device',
          'Only scan when qrAvailable=true / a QR file is present',
        ],
      });
    }

    return response({
      ...enriched,
      code: 'NEEDS_PAIRING',
      qrAvailable: true,
      qrPath,
      qrFilePresent,
      qrUpdatedAt: status.qrUpdatedAt || null,
      phoneSteps: [
        'Open the QR PNG locally with Preview/Finder (private file; mode 0600).',
        'On the phone: WhatsApp → Settings → Linked Devices → Link a Device',
        'Scan the QR, then poll whatsapp_wait_ready until ready=true',
      ],
      openCommand: `open ${qrPath}`,
    });
  } catch (error) {
    return failureFromRpc(error, account || null);
  }
});

server.registerTool('whatsapp_wait_ready', {
  description: 'Wait until the backend is ready. After idle_cold this wakes Chrome (up to ~3 minutes). Also used after starting the service or while the user scans a pairing QR. Returns structured status/guidance on ready, pairing, lock-pause, or timeout.',
  inputSchema: {
    account: z.string().optional().describe('Account ID or alias. Omit to use the default account.'),
    timeoutSec: z.number().int().min(1).max(180).default(180).describe('Seconds to wait before returning timeout guidance. Default 180 covers a cold Chrome wake.'),
    intervalMs: z.number().int().min(250).max(10000).default(2000).describe('Polling interval in milliseconds.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ account, timeoutSec = 180, intervalMs = 2000 } = {}) => {
  try {
    const accountMeta = await resolveAccount(account || null);
    const deadline = Date.now() + (timeoutSec * 1000);
    let last = null;
    let attempts = 0;
    let wakeAttempted = false;

    while (Date.now() <= deadline) {
      attempts += 1;
      last = enrichStatus(
        accountMeta,
        await readAccountStatus({
          accountId: accountMeta.id,
          pathsForAccount: accountMeta.paths,
          timeoutMs: Math.min(5000, intervalMs),
        }),
      );
      if (last.ready) {
        return response({ waited: true, attempts, timedOut: false, ...last });
      }
      if (last.phase === 'pairing' || last.code === 'NEEDS_PAIRING') {
        return response({
          waited: true,
          attempts,
          timedOut: false,
          ...last,
          agentNextSteps: [
            'Backend is waiting for QR scan.',
            'Call whatsapp_qr and ask the user to scan, then call whatsapp_wait_ready again.',
            ...last.agentNextSteps,
          ],
        });
      }
      if (last.phase === 'paused_by_lock' || last.code === 'PAUSED_BY_LOCK') {
        return response({
          waited: true,
          attempts,
          timedOut: false,
          ...last,
        });
      }
      const canWake = Boolean(last.canWake)
        || isIdleColdPhase(last.phase)
        || last.phase === 'starting'
        || last.phase === 'resuming_after_lock';
      if (canWake && !wakeAttempted) {
        wakeAttempted = true;
        try {
          const remainingMs = Math.max(5000, deadline - Date.now());
          const woken = await routedRpcCall('wake', {}, {
            timeoutMs: remainingMs,
            account: account || null,
          });
          last = enrichStatus(accountMeta, { source: 'wake', ...woken });
          if (last.ready) {
            return response({ waited: true, attempts, timedOut: false, woke: true, ...last });
          }
        } catch (error) {
          last = enrichStatus(
            accountMeta,
            await readAccountStatus({
              accountId: accountMeta.id,
              pathsForAccount: accountMeta.paths,
              timeoutMs: 5000,
            }).catch(() => ({ ready: false, phase: last.phase, error: error.message })),
          );
          last.backendError = error.message;
        }
      }
      if (Date.now() + intervalMs > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return response({
      waited: true,
      attempts,
      timedOut: true,
      ...(last || enrichStatus(accountMeta, { ready: false, phase: 'stopped', error: 'No status samples collected' })),
      userMessage: last?.userMessage || 'Timed out waiting for WhatsApp backend readiness.',
      agentNextSteps: [
        `Timed out after ${timeoutSec}s and ${attempts} poll(s).`,
        'Call whatsapp_doctor and share userMessage with the user.',
        ...(last?.agentNextSteps || []),
      ],
    });
  } catch (error) {
    return failureFromRpc(error, account || null);
  }
});

register('whatsapp_compatibility', {
  description: 'Return the local WhatsApp backend compatibility report: current WhatsApp Web, browser, Node, pinned dependency versions, and enabled security controls. This does not read chats or messages.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, 'compatibility', 5000);

register('whatsapp_compatibility_self_test', {
  description: 'Run a content-free WhatsApp compatibility self-test. Returns connection state, required module/function availability, and chat count only; it never returns chat IDs, names, previews, or messages. Use this before approving a changed runtime baseline.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, 'compatibilitySelfTest', 10000);

register('whatsapp_security_audit', {
  description: 'Audit local WhatsApp runtime isolation without reading content: FileVault, private path ownership/modes, Unix socket, native approval helpers, Chrome pipe transport, and absence of a backend TCP listener.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, 'securityAudit', 10000);

register('whatsapp_list_chats', {
  description: 'List WhatsApp chats available to the paired local account. Returns chat IDs, names, unread counts, and timestamps. Last-message previews are omitted by default to minimize disclosure. Reading does not intentionally mark chats as seen. If the backend is not ready, returns structured login/start guidance.',
  inputSchema: {
    limit: z.number().int().min(1).max(200).default(50),
    unreadOnly: z.boolean().default(false),
    includeArchived: z.boolean().default(true),
    includeLastMessage: z.boolean().default(false).describe('Request short last-message previews only when the user explicitly needs them.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, 'listChats');

register('whatsapp_unread_digest', {
  description: 'Read-only unread inbox digest. Returns unread chat counts, optional last-message previews, and a nextSince cursor for later polls. Never marks chats as seen. Prefer this over listing then re-reading every chat when the user asks what is new.',
  inputSchema: {
    limit: z.number().int().min(1).max(200).default(20),
    includePreview: z.boolean().default(true).describe('Include short last-message previews. Set false to return counts only.'),
    includeArchived: z.boolean().default(true),
    since: z.number().int().min(0).optional().describe('Optional WhatsApp chat timestamp cursor from a previous digest.nextSince. Only chats newer than this are returned.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, 'unreadDigest');

register('whatsapp_read_messages', {
  description: 'Read recent messages from one WhatsApp chat by chat ID or exact unique name. Media is never downloaded. Reading does not intentionally mark the chat as seen. If not authenticated/ready, returns structured guidance instead of content.',
  inputSchema: {
    chat: z.string().min(1).describe('Prefer the stable chat ID returned by whatsapp_list_chats.'),
    limit: z.number().int().min(1).max(200).default(30),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, 'getMessages');

register('whatsapp_search_messages', {
  description: 'Search cached WhatsApp message text across all chats or within one chat. Media is never downloaded. Requires a ready backend.',
  inputSchema: {
    query: z.string().min(1),
    chat: z.string().min(1).optional().describe('Optional chat ID or exact unique name.'),
    limit: z.number().int().min(1).max(100).default(50),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, 'searchMessages');

register('whatsapp_message_status', {
  description: 'Read the current WhatsApp acknowledgement state for one exact message ID: pending, server (one check), device (two checks), read (two blue checks when receipts are enabled), or played. This does not mutate the chat.',
  inputSchema: {
    messageId: z.string().min(1),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, 'messageStatus');

register('whatsapp_get_last_call', {
  description: 'Get info about the last incoming WhatsApp call and any in-progress voice-bot call. Experimental: web client can auto-accept and inject bot audio via Chrome fake microphone.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, 'getLastCall');

register('whatsapp_reject_call', {
  description: 'Reject the current incoming WhatsApp call if it is still ringing.',
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, 'rejectCall');

register('whatsapp_accept_call', {
  description: 'Manually accept the latest incoming WhatsApp call (experimental voice-bot). By default plays bot WAV via Chrome fake mic then hangs up. Prefer auto-accept for live tests.',
  inputSchema: {
    hangupAfterAudio: z.boolean().optional().describe('Hang up after bot audio finishes. Default true.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, 'acceptCall', 60000);

register('whatsapp_hangup_call', {
  description: 'Hang up the currently active WhatsApp call (experimental).',
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, 'hangupCall');

register('whatsapp_prepare_send', {
  description: 'Prepare and preview a WhatsApp message without sending it. Always use this first, show the exact target and text to the user, and wait for explicit approval before requesting the native Touch ID dialog.',
  inputSchema: {
    chat: z.string().min(1).describe('Chat ID or exact unique chat name.'),
    text: z.string().min(1).max(10000),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, 'prepareSend');

register('whatsapp_prepare_reply', {
  description: 'Prepare a quote-reply to one exact WhatsApp message without sending it. Show the quoted message ID, quoted preview, and reply text to the user, then wait for explicit approval before requesting the native Touch ID dialog.',
  inputSchema: {
    chat: z.string().min(1).describe('Chat ID or exact unique chat name.'),
    messageId: z.string().min(1).describe('Exact quoted message ID from whatsapp_read_messages or whatsapp_search_messages.'),
    text: z.string().min(1).max(10000),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, 'prepareReply');

register('whatsapp_prepare_rich_test', {
  description: 'Prepare one deterministic synthetic E2E asset without sending it. Supported kinds are image, document, location, contact, and sticker. No user files, address book entries, or private locations are read. Show the exact preview and SHA-256 to the user before requesting local approval.',
  inputSchema: {
    chat: z.string().min(1).describe('Chat ID or exact unique chat name.'),
    kind: z.enum(['image', 'document', 'location', 'contact', 'sticker']),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, 'prepareRichTest');

register('whatsapp_prepare_mark_read', {
  description: 'Prepare an externally visible mark-read action without executing it. Show the exact preview and wait for explicit user approval before requesting the native Touch ID dialog.',
  inputSchema: {
    chat: z.string().min(1).describe('Chat ID or exact unique chat name.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, 'prepareMarkRead');

register('whatsapp_prepare_reaction', {
  description: 'Prepare an emoji reaction to one exact message without sending it. Show the exact message ID, preview, and reaction to the user before requesting native Touch ID approval.',
  inputSchema: {
    chat: z.string().min(1).describe('Chat ID or exact unique chat name.'),
    messageId: z.string().min(1),
    reaction: z.enum(['✅', '👍', '❤️', '😂', '😮', '😢', '🙏']),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, 'prepareReaction');

register('whatsapp_request_local_approval', {
  description: 'EXTERNALLY VISIBLE ACTION: opens a native macOS dialog containing the immutable target, action type, and exact prepared preview. The prepared send, quote-reply, reaction, or mark-read action executes only after direct Touch ID or macOS login-password authorization. Call only after showing the preview and receiving explicit approval to open the dialog.',
  inputSchema: {
    approvalId: z.string().uuid(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, 'requestLocalApproval', 120000);

register('whatsapp_send_outcome', {
  description: 'Read the durable outcome of a prepared WhatsApp send by approval ID. Use this after a timeout; never prepare a duplicate while the outcome is sending or outcome-unknown.',
  inputSchema: {
    approvalId: z.string().uuid(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, 'getSendOutcome', 5000);

async function main() {
  log.info('start', 'transport=stdio');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('ready', 'tools=22');
}

main().catch((error) => {
  log.error('fatal', error.stack || error.message);
  process.exit(1);
});
