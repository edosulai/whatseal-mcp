#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  accountPaths,
  createLogger,
  parseCommonArgs,
  readJson,
  resolveAccountRecord,
  rpcCall,
} from './lib/core.mjs';

const rawArgs = process.argv.slice(2);
const { verbose, help } = parseCommonArgs(rawArgs);
const log = createLogger('whatsapp-cli', verbose);
const args = rawArgs.filter((arg) => !['--verbose', '-v', '--help', '-h'].includes(arg));
const command = args[0] || (help ? 'help' : 'status');
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  process.stdout.write(`Usage: node cli.mjs <command> [options] [--account ID|alias] [--verbose|-v]

Commands:
  status
  compatibility
  compatibility-self-test
  security-audit
  qr
  chats [--limit N] [--unread] [--include-preview]
  messages <chat-id-or-exact-name> [--limit N]
  search <query> [--chat ID_OR_NAME] [--limit N]
  message-status <message-id>
  prepare-send <chat-id-or-exact-name> <text>
  prepare-rich-test <chat-id-or-exact-name> <image|document|location|contact|sticker>
  prepare-mark-read <chat-id-or-exact-name>
  prepare-reaction <chat-id-or-exact-name> <message-id> <emoji>
  request-approval <approval-id>
  send-outcome <approval-id>

request-approval opens an immutable native preview and requires Touch ID or the
macOS login password before an externally visible send, reaction, or mark-read action.
`);
}

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function positional() {
  const result = [];
  const optionsWithValues = new Set(['--limit', '--chat', '--account']);
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (optionsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('--')) continue;
    result.push(value);
  }
  return result;
}

async function resolveCliAccount() {
  const accountParam = option('--account');
  const config = await readJson(path.join(PROJECT_ROOT, 'accounts.json'), { accounts: [], default: null });
  if (!accountParam && (!config.accounts || config.accounts.length === 0)) {
    return { id: process.env.WHATSAPP_ACCOUNT_ID || null, record: null, paths: accountPaths(process.env.WHATSAPP_ACCOUNT_ID || null) };
  }
  return resolveAccountRecord(config, accountParam || null);
}

async function main() {
  log.info('start', `command=${command}`);
  if (command === 'help') {
    usage();
    log.info('complete', 'command=help');
    return;
  }

  const accountMeta = await resolveCliAccount();
  const pathsForAccount = accountMeta.paths;
  const rpc = (method, params = {}, options = {}) => rpcCall(method, params, {
    ...options,
    socketPath: pathsForAccount.socket,
  });

  log.debug('command', `${command} account=${accountMeta.id || 'default'}`);
  let result;
  if (command === 'status') {
    try {
      result = await rpc('status', {}, { timeoutMs: 5000 });
      result = { account: accountMeta.id, alias: accountMeta.record?.alias || null, ...result };
    } catch (error) {
      const saved = await readJson(pathsForAccount.stateFile, {});
      result = {
        account: accountMeta.id,
        alias: accountMeta.record?.alias || null,
        ready: false,
        phase: 'stopped',
        savedState: saved,
        error: error.message,
      };
    }
  } else if (command === 'compatibility') {
    result = await rpc('compatibility', {}, { timeoutMs: 5000 });
  } else if (command === 'compatibility-self-test') {
    result = await rpc('compatibilitySelfTest', {}, { timeoutMs: 10000 });
  } else if (command === 'security-audit') {
    result = await rpc('securityAudit', {}, { timeoutMs: 10000 });
  } else if (command === 'qr') {
    const state = await readJson(pathsForAccount.stateFile, {});
    if (!state.qrAvailable && state.phase !== 'pairing') {
      throw new Error(`No pairing QR is currently available for account ${accountMeta.id || 'default'} (phase=${state.phase || 'unknown'}).`);
    }
    await readFile(pathsForAccount.qrFile);
    result = {
      account: accountMeta.id,
      alias: accountMeta.record?.alias || null,
      qrPath: pathsForAccount.qrFile,
      updatedAt: state.qrUpdatedAt,
      phoneSteps: [
        'Open the QR PNG locally',
        'WhatsApp → Settings → Linked Devices → Link a Device',
      ],
    };
  } else if (command === 'chats') {
    result = await rpc('listChats', {
      limit: Number(option('--limit', 50)),
      unreadOnly: args.includes('--unread'),
      includeArchived: true,
      includeLastMessage: args.includes('--include-preview'),
    });
  } else if (command === 'messages') {
    const [chat] = positional();
    if (!chat) throw new Error('messages requires a chat ID or exact chat name.');
    result = await rpc('getMessages', { chat, limit: Number(option('--limit', 30)) });
  } else if (command === 'search') {
    const [query] = positional();
    if (!query) throw new Error('search requires a query. Quote multi-word searches.');
    result = await rpc('searchMessages', {
      query,
      chat: option('--chat'),
      limit: Number(option('--limit', 50)),
    });
  } else if (command === 'message-status') {
    const [messageId] = positional();
    if (!messageId) throw new Error('message-status requires a message ID.');
    result = await rpc('messageStatus', { messageId });
  } else if (command === 'prepare-send') {
    const [chat, text] = positional();
    if (!chat || !text) throw new Error('prepare-send requires a chat and quoted message text.');
    result = await rpc('prepareSend', { chat, text });
  } else if (command === 'prepare-rich-test') {
    const [chat, kind] = positional();
    if (!chat || !kind) throw new Error('prepare-rich-test requires a chat and asset kind.');
    result = await rpc('prepareRichTest', { chat, kind });
  } else if (command === 'prepare-mark-read') {
    const [chat] = positional();
    if (!chat) throw new Error('prepare-mark-read requires a chat.');
    result = await rpc('prepareMarkRead', { chat });
  } else if (command === 'prepare-reaction') {
    const [chat, messageId, reaction] = positional();
    if (!chat || !messageId || !reaction) throw new Error('prepare-reaction requires a chat, message ID, and emoji.');
    result = await rpc('prepareReaction', { chat, messageId, reaction });
  } else if (command === 'request-approval') {
    const [approvalId] = positional();
    if (!approvalId) throw new Error('request-approval requires an approval ID.');
    result = await rpc('requestLocalApproval', { approvalId }, { timeoutMs: 120000 });
  } else if (command === 'send-outcome') {
    const [approvalId] = positional();
    if (!approvalId) throw new Error('send-outcome requires an approval ID.');
    result = await rpc('getSendOutcome', { approvalId }, { timeoutMs: 5000 });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  log.info('complete', `command=${command}`);
}

main().catch((error) => {
  log.error('failed', error.message);
  process.exitCode = 1;
});
