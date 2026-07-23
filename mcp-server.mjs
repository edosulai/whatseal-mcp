#!/usr/bin/env node
import process from 'node:process';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { accountPaths, createLogger, parseCommonArgs, readJson, rpcCall } from './lib/core.mjs';

const require = createRequire(import.meta.url);
const { verbose, help } = parseCommonArgs(process.argv.slice(2));
const log = createLogger('whatsapp-mcp', verbose);

if (help) {
  process.stdout.write('Usage: node mcp-server.mjs [--verbose|-v]\n\nRuns the local WhatsApp MCP bridge over stdio.\nSupports multiple accounts via the account parameter.\n');
  process.exit(0);
}

const accountsConfig = readJson(new URL('./accounts.json', import.meta.url).pathname, { accounts: [], default: null });
let accounts = null;

async function getAccounts() {
  if (accounts) return accounts;
  accounts = await accountsConfig;
  return accounts;
}

async function resolveSocketPath(accountParam) {
  const config = await getAccounts();
  const id = accountParam || config.default || null;
  if (!id && config.accounts.length === 0) {
    // Legacy single-account fallback
    return accountPaths(null).socket;
  }
  if (!id && config.accounts.length > 0) {
    return accountPaths(config.accounts[0].id).socket;
  }
  const match = config.accounts.find((a) => a.id === id || a.alias === id);
  if (!match) throw new Error(`Unknown account: ${id}. Available: ${config.accounts.map((a) => `${a.id} (${a.alias})`).join(', ')}`);
  return accountPaths(match.id).socket;
}

async function routedRpcCall(method, params, { timeoutMs = 30000, account = null } = {}) {
  const socketPath = await resolveSocketPath(account);
  return rpcCall(method, params, { timeoutMs, socketPath });
}

const server = new McpServer({ name: 'local-whatsapp', version: '2.0.0' });

function response(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function failure(error) {
  log.error('tool-failed', error.message);
  return { isError: true, content: [{ type: 'text', text: error.message }] };
}

function register(name, config, method, timeoutMs = 30000) {
  // Inject optional account param into every tool's input schema
  const schema = { account: z.string().optional().describe('Account ID or alias. Omit to use the default account.'), ...config.inputSchema };
  server.registerTool(name, { ...config, inputSchema: schema }, async (params) => {
    try {
      const { account, ...rest } = params;
      log.debug('tool-call', `${name} account=${account || 'default'}`);
      return response(await routedRpcCall(method, rest, { timeoutMs, account }));
    } catch (error) {
      return failure(error);
    }
  });
}

register('whatsapp_status', {
  description: 'Check whether the private local WhatsApp linked-device backend is paired and ready. This does not read messages.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, 'status', 5000);

server.registerTool('whatsapp_list_accounts', {
  description: 'List all configured WhatsApp accounts with their IDs, aliases, and connection status. Use this to discover available accounts before specifying an account parameter.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    const config = await getAccounts();
    const statuses = await Promise.all(config.accounts.map(async (a) => {
      try {
        const status = await routedRpcCall('status', {}, { timeoutMs: 3000, account: a.id });
        return { ...a, phase: status.phase, ready: status.ready, policyMode: status.policyMode };
      } catch {
        return { ...a, phase: 'unreachable', ready: false, policyMode: null };
      }
    }));
    return response({ default: config.default, accounts: statuses });
  } catch (error) {
    return failure(error);
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
  description: 'List WhatsApp chats available to the paired local account. Returns chat IDs, names, unread counts, and timestamps. Last-message previews are omitted by default to minimize disclosure. Reading does not intentionally mark chats as seen.',
  inputSchema: {
    limit: z.number().int().min(1).max(200).default(50),
    unreadOnly: z.boolean().default(false),
    includeArchived: z.boolean().default(true),
    includeLastMessage: z.boolean().default(false).describe('Request short last-message previews only when the user explicitly needs them.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, 'listChats');

register('whatsapp_read_messages', {
  description: 'Read recent messages from one WhatsApp chat by chat ID or exact unique name. Media is never downloaded. Reading does not intentionally mark the chat as seen.',
  inputSchema: {
    chat: z.string().min(1).describe('Prefer the stable chat ID returned by whatsapp_list_chats.'),
    limit: z.number().int().min(1).max(200).default(30),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, 'getMessages');

register('whatsapp_search_messages', {
  description: 'Search cached WhatsApp message text across all chats or within one chat. Media is never downloaded.',
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

register('whatsapp_prepare_send', {
  description: 'Prepare and preview a WhatsApp message without sending it. Always use this first, show the exact target and text to the user, and wait for explicit approval before requesting the native Touch ID dialog.',
  inputSchema: {
    chat: z.string().min(1).describe('Chat ID or exact unique chat name.'),
    text: z.string().min(1).max(10000),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, 'prepareSend');

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
  description: 'EXTERNALLY VISIBLE ACTION: opens a native macOS dialog containing the immutable target, action type, and exact prepared preview. The prepared send, reaction, or mark-read action executes only after direct Touch ID or macOS login-password authorization. Call only after showing the preview and receiving explicit approval to open the dialog.',
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
  log.info('ready', 'tools=14');
}

main().catch((error) => {
  log.error('fatal', error.stack || error.message);
  process.exit(1);
});