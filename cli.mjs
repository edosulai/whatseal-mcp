#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { createLogger, parseCommonArgs, paths, readJson, rpcCall } from './lib/core.mjs';

const rawArgs = process.argv.slice(2);
const { verbose, help } = parseCommonArgs(rawArgs);
const log = createLogger('whatsapp-cli', verbose);
const args = rawArgs.filter((arg) => !['--verbose', '-v', '--help', '-h'].includes(arg));
const command = args[0] || (help ? 'help' : 'status');

function usage() {
  process.stdout.write(`Usage: node cli.mjs <command> [options] [--verbose|-v]\n\nCommands:\n  status\n  compatibility\n  compatibility-self-test\n  security-audit\n  qr\n  chats [--limit N] [--unread] [--include-preview]\n  messages <chat-id-or-exact-name> [--limit N]\n  search <query> [--chat ID_OR_NAME] [--limit N]\n  message-status <message-id>\n  prepare-send <chat-id-or-exact-name> <text>\n  prepare-rich-test <chat-id-or-exact-name> <image|document|location|contact|sticker>\n  prepare-mark-read <chat-id-or-exact-name>\n  prepare-reaction <chat-id-or-exact-name> <message-id> <emoji>\n  request-approval <approval-id>\n  send-outcome <approval-id>\n\nrequest-approval opens an immutable native preview and requires Touch ID or the\nmacOS login password before an externally visible send, reaction, or mark-read action.\n`);
}

function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function positional() {
  const result = [];
  const optionsWithValues = new Set(['--limit', '--chat']);
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

async function main() {
  log.info('start', `command=${command}`);
  if (command === 'help') {
    usage();
    log.info('complete', 'command=help');
    return;
  }

  log.debug('command', command);
  let result;
  if (command === 'status') {
    try {
      result = await rpcCall('status', {}, { timeoutMs: 5000 });
    } catch (error) {
      const saved = await readJson(paths.stateFile, {});
      result = { ready: false, phase: 'stopped', savedState: saved, error: error.message };
    }
  } else if (command === 'compatibility') {
    result = await rpcCall('compatibility', {}, { timeoutMs: 5000 });
  } else if (command === 'compatibility-self-test') {
    result = await rpcCall('compatibilitySelfTest', {}, { timeoutMs: 10000 });
  } else if (command === 'security-audit') {
    result = await rpcCall('securityAudit', {}, { timeoutMs: 10000 });
  } else if (command === 'qr') {
    const state = await readJson(paths.stateFile, {});
    if (!state.qrAvailable) throw new Error('No pairing QR is currently available.');
    await readFile(paths.qrFile);
    result = { qrPath: paths.qrFile, updatedAt: state.qrUpdatedAt };
  } else if (command === 'chats') {
    result = await rpcCall('listChats', {
      limit: Number(option('--limit', 50)),
      unreadOnly: args.includes('--unread'),
      includeArchived: true,
      includeLastMessage: args.includes('--include-preview'),
    });
  } else if (command === 'messages') {
    const [chat] = positional();
    if (!chat) throw new Error('messages requires a chat ID or exact chat name.');
    result = await rpcCall('getMessages', { chat, limit: Number(option('--limit', 30)) });
  } else if (command === 'search') {
    const [query] = positional();
    if (!query) throw new Error('search requires a query. Quote multi-word searches.');
    result = await rpcCall('searchMessages', {
      query,
      chat: option('--chat'),
      limit: Number(option('--limit', 50)),
    });
  } else if (command === 'message-status') {
    const [messageId] = positional();
    if (!messageId) throw new Error('message-status requires a message ID.');
    result = await rpcCall('messageStatus', { messageId });
  } else if (command === 'prepare-send') {
    const [chat, text] = positional();
    if (!chat || !text) throw new Error('prepare-send requires a chat and quoted message text.');
    result = await rpcCall('prepareSend', { chat, text });
  } else if (command === 'prepare-rich-test') {
    const [chat, kind] = positional();
    if (!chat || !kind) throw new Error('prepare-rich-test requires a chat and asset kind.');
    result = await rpcCall('prepareRichTest', { chat, kind });
  } else if (command === 'prepare-mark-read') {
    const [chat] = positional();
    if (!chat) throw new Error('prepare-mark-read requires a chat.');
    result = await rpcCall('prepareMarkRead', { chat });
  } else if (command === 'prepare-reaction') {
    const [chat, messageId, reaction] = positional();
    if (!chat || !messageId || !reaction) throw new Error('prepare-reaction requires a chat, message ID, and emoji.');
    result = await rpcCall('prepareReaction', { chat, messageId, reaction });
  } else if (command === 'request-approval') {
    const [approvalId] = positional();
    if (!approvalId) throw new Error('request-approval requires an approval ID.');
    result = await rpcCall('requestLocalApproval', { approvalId }, { timeoutMs: 120000 });
  } else if (command === 'send-outcome') {
    const [approvalId] = positional();
    if (!approvalId) throw new Error('send-outcome requires an approval ID.');
    result = await rpcCall('getSendOutcome', { approvalId }, { timeoutMs: 5000 });
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