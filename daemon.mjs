#!/usr/bin/env node
import { chmod, lstat, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import process from 'node:process';
import QRCode from 'qrcode';
import whatsapp from 'whatsapp-web.js';
import express from 'express';

import {
  accountPaths,
  createLogger,
  DraftStore,
  ensurePrivateDirectories,
  parseCommonArgs,
  readJson,
  truncateText,
  writeFileAtomic,
  writeJsonAtomic,
} from './lib/core.mjs';

import {
  deepProbeVoipStack,
  installCallBridge,
  patchIncomingCallListener,
  playBotAudioBase64,
  probeCallBridge,
  voipAcceptCall,
  voipEndCall,
  voipRejectCall,
} from './lib/call-bridge.mjs';

// Prefer CLI --account, then WHATSAPP_ACCOUNT_ID from LaunchAgent/env.
// LaunchAgent historically only set the env var (no CLI flag); without this fallback
// the daemon bound the legacy root paths and ignored per-account auth/state.
const accountArgIdx = process.argv.indexOf('--account');
const accountFromCli = accountArgIdx !== -1 ? process.argv[accountArgIdx + 1] : null;
const accountId = accountFromCli || process.env.WHATSAPP_ACCOUNT_ID || null;
const paths = accountPaths(accountId);

function resolveHttpPort(id = null) {
  const fromEnv = Number(process.env.WHATSAPP_HTTP_PORT || 0);
  if (Number.isInteger(fromEnv) && fromEnv >= 1 && fromEnv <= 65535) return fromEnv;

  // Port = 30000 + last 4 digits of account id (preserves leading zeros in the label).
  // Numeric ids map to 30000-39999. Non-numeric ids fall back to 30001.
  //   account beta → 30001
  //   account alpha → 30001
  // Range 30000–39999 is always unprivileged. Override with WHATSAPP_HTTP_PORT.
  const digits = String(id ?? 'alpha').replace(/\D/g, '') || 'alpha';
  const last4 = digits.slice(-4).padStart(4, '0');
  return 30000 + Number.parseInt(last4, 10);
}

process.umask(0o077);

const { Client, LocalAuth, Location, MessageMedia } = whatsapp;
const require = createRequire(import.meta.url);
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
const execFileAsync = promisify(execFile);
const appPackage = require('./package.json');
const whatsappPackage = require('whatsapp-web.js/package.json');
const appLock = require('./package-lock.json');
const packageLockPath = require.resolve('./package-lock.json');
const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
const runtimeSourceFiles = [
  'daemon.mjs',
  'lib/core.mjs',
  'mcp-server.mjs',
  'mcp-wrapper.sh',
  'cli.mjs',
  'approve-baseline.mjs',
  'native-approval.swift',
  'native-baseline-approval.swift',
  'install-launchagent.sh',
  'package.json',
];
const startupBackendSourceSha256Promise = hashNamedFiles(sourceRoot, runtimeSourceFiles);
const startupInstalledDependenciesSha256Promise = hashDirectoryTree(path.join(sourceRoot, 'node_modules'));
const { verbose, help } = parseCommonArgs(process.argv.slice(2));
const log = createLogger('whatsapp-daemon', verbose);
const drafts = new DraftStore();
const activeSockets = new Set();
const sendOutcomes = new Map();
const acknowledgementHistory = new Map();

// Experimental voice-bot settings (all toggles are env-based; restart daemon after change).
//
// ON/OFF switches:
//   WHATSAPP_AUTO_ACCEPT_CALLS=0   → detect only, do not auto-answer
//   WHATSAPP_BOT_AUDIO_INJECT=0    → accept without WebAudio mic inject / greeting play
//   WHATSAPP_BOT_HANGUP_AFTER_AUDIO=0 → leave call open after accept (no auto hangup)
//   WHATSAPP_HEADLESS=1            → Chrome --headless=new (no visible window)
//
// Audio file:
//   WHATSAPP_BOT_AUDIO=/abs/path.wav  (PCM WAV only; sibling .m4a is preview-only)
// Chrome also gets --use-file-for-fake-audio-capture as a fallback, but real peer
// audio requires WebAudio inject into the patched getUserMedia stream (bridge v6+).
const defaultBotAudio = path.join(sourceRoot, 'assets/audio/bot-greeting-id.wav');
const botAudioPath = process.env.WHATSAPP_BOT_AUDIO
  ? path.resolve(process.env.WHATSAPP_BOT_AUDIO)
  : defaultBotAudio;
const autoAcceptCalls = process.env.WHATSAPP_AUTO_ACCEPT_CALLS !== '0';
const botAudioInject = process.env.WHATSAPP_BOT_AUDIO_INJECT !== '0';
const botHangupAfterAudio = process.env.WHATSAPP_BOT_HANGUP_AFTER_AUDIO !== '0';
// Headed Chrome is more reliable for WhatsApp call UI + WebRTC accept.
// Set WHATSAPP_HEADLESS=1 to force pure headless again (validated working with VoIP-first).
const voiceBotHeadless = process.env.WHATSAPP_HEADLESS === '1'
  ? true
  : (autoAcceptCalls ? false : true);
// After greeting finishes, wait this long then hang up (default 800ms).
const botHangupPaddingMs = Number(process.env.WHATSAPP_BOT_HANGUP_PADDING_MS || 800);
let lastCall = null;
let activeBotCall = null;
let botCallInFlight = false;
let cachedChatLockSecret = undefined;

function logJson(level, event, detail) {
  const payload = detail === undefined
    ? ''
    : (typeof detail === 'string' ? detail : JSON.stringify(detail));
  if (level === 'error') log.error(event, payload);
  else if (level === 'debug') log.debug(event, payload);
  else log.info(event, payload);
}

if (help) {
  process.stdout.write('Usage: node daemon.mjs [--verbose|-v]\n\nRuns the private local WhatsApp Web backend.\n');
  process.exit(0);
}


function assertSendRateLimit() {
  const now = Date.now();
  const sent = [...sendOutcomes.values()]
    .filter((outcome) => ['sending', 'sent', 'outcome-unknown'].includes(outcome.state) && Date.parse(outcome.updatedAt))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const hourly = sent.filter((outcome) => now - Date.parse(outcome.updatedAt) < 60 * 60 * 1000).length;
  const daily = sent.filter((outcome) => now - Date.parse(outcome.updatedAt) < 24 * 60 * 60 * 1000).length;
  if (hourly >= 20) throw new Error('Send rate limit reached: 20 messages per rolling hour.');
  if (daily >= 100) throw new Error('Send rate limit reached: 100 messages per rolling 24 hours.');
  const latest = sent[0];
  if (latest && now - Date.parse(latest.updatedAt) < 3000) {
    throw new Error('Send cooldown active. Wait at least three seconds between messages.');
  }
}

let phase = 'starting';
let connectionState = null;
let qrUpdatedAt = null;
let readyAt = null;
let shuttingDown = false;
let server;
let httpServer;
let qrGeneration = 0;
let stateWriteQueue = Promise.resolve();
let authenticatedRecoveryTimer = null;
let authenticatedRecoveryInFlight = false;
let authenticatedRecoveryAttempts = 0;
let readyFinalizationInFlight = null;
let healthTimer = null;
let sendApprovalInFlight = false;
let outcomeWriteQueue = Promise.resolve();

const syntheticDocument = Buffer.from([
  'WhatsApp Agent E2E Test Document',
  'Generated locally from a fixed, non-personal payload.',
  'No user files were read to create this attachment.',
  'Test date: 2026-07-21',
  '',
].join('\n'), 'utf8');
const syntheticVCard = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:E2E Synthetic Contact',
  'TEL;TYPE=CELL:+12025550123',
  'NOTE:Synthetic test contact; not sourced from the address book.',
  'END:VCARD',
].join('\r\n');

const chromePath = process.env.WHATSAPP_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const approvalHelper = process.env.WHATSAPP_APPROVAL_HELPER || `${paths.state}/native-approval`;
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'primary', dataPath: paths.auth }),
  authTimeoutMs: 120000,
  qrMaxRetries: 0,
  puppeteer: {
    // Headed mode when auto-accept is enabled: WhatsApp's call accept UI/WebRTC
    // is more reliable with a real window than pure headless.
    headless: voiceBotHeadless,
    executablePath: chromePath,
    pipe: true,
    args: [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-features=Translate,MediaRouter',
      '--no-first-run',
      '--no-default-browser-check',
      // Experimental voice-bot: inject WAV as the page microphone so WA can send it.
      // File can be swapped later via WHATSAPP_BOT_AUDIO without code changes.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${botAudioPath}`,
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,900',
    ],
    defaultViewport: { width: 1280, height: 900 },
  },
});

// WhatsApp Web can emit several hasSynced callbacks while its SPA is still
// replacing the main frame. whatsapp-web.js then calls attachEventListeners()
// concurrently, which races Puppeteer's Runtime.addBinding and can leave the
// client authenticated but never ready. Coalesce concurrent calls and wait for
// WhatsApp's own Stream model to exist before exposing any bindings.
const originalAttachEventListeners = client.attachEventListeners.bind(client);
let attachEventListenersInFlight = null;
client.attachEventListeners = (...args) => {
  if (attachEventListenersInFlight) {
    log.debug('listener-attach-coalesced', 'reusing the active listener installation');
    return attachEventListenersInFlight;
  }
  attachEventListenersInFlight = (async () => {
    log.info('listener-attach-wait', 'waiting for the WhatsApp Stream model and stable document');
    await client.pupPage.waitForFunction(
      () => {
        const stream = window.require?.('WAWebStreamModel')?.Stream;
        return document.readyState === 'complete' && Boolean(stream);
      },
      { timeout: 60000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    log.info('listener-attach-start', 'installing WhatsApp event listeners');
    const result = await originalAttachEventListeners(...args);
    log.info('listener-attach-complete', 'WhatsApp event listeners installed');
    return result;
  })().finally(() => {
    attachEventListenersInFlight = null;
  });
  return attachEventListenersInFlight;
};

async function publishState(extra = {}) {
  stateWriteQueue = stateWriteQueue.catch(() => {}).then(() => writeJsonAtomic(paths.stateFile, {
      phase,
      connectionState,
      ready: phase === 'ready',
      qrAvailable: phase === 'pairing',
      qrPath: phase === 'pairing' ? paths.qrFile : null,
      qrUpdatedAt,
      readyAt,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      ...extra,
    }));
  await stateWriteQueue;
}

async function removeQr() {
  await rm(paths.qrFile, { force: true });
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function createSyntheticPng() {
  const width = 256;
  const height = 256;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const checker = (Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0;
      const diagonal = Math.abs(x - y) < 10 || Math.abs(x + y - width) < 10;
      pixels[offset] = diagonal ? 255 : checker ? 38 : 16;
      pixels[offset + 1] = diagonal ? 255 : checker ? 166 : 88;
      pixels[offset + 2] = diagonal ? 255 : checker ? 154 : 120;
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function getSyntheticRichAction(kind) {
  const image = createSyntheticPng();
  const specifications = {
    image: {
      preview: 'Send a locally generated 256×256 PNG test image. No user file is read. Caption: [E2E TEST 2/6 — IMAGE]',
      expectedTypes: ['image'],
      content: () => new MessageMedia('image/png', image.toString('base64'), 'whatsapp-agent-e2e.png', image.length),
      options: { caption: '[E2E TEST 2/6 — IMAGE]' },
      attest: image,
    },
    document: {
      preview: 'Send a locally generated plain-text test document named whatsapp-agent-e2e.txt. No user file is read.',
      expectedTypes: ['document'],
      content: () => new MessageMedia('text/plain', syntheticDocument.toString('base64'), 'whatsapp-agent-e2e.txt', syntheticDocument.length),
      options: { sendMediaAsDocument: true, caption: '[E2E TEST 3/6 — DOCUMENT]' },
      attest: syntheticDocument,
    },
    location: {
      preview: 'Send the public location Monumen Nasional, Gambir, Jakarta Pusat (-6.175392, 106.827153).',
      expectedTypes: ['location'],
      content: () => new Location(-6.175392, 106.827153, {
        name: 'Monumen Nasional — E2E test',
        address: 'Gambir, Jakarta Pusat',
        url: 'https://www.openstreetmap.org/?mlat=-6.175392&mlon=106.827153',
      }),
      options: {},
      attest: Buffer.from('location|-6.175392|106.827153|Monumen Nasional — E2E test|Gambir, Jakarta Pusat', 'utf8'),
    },
    contact: {
      preview: 'Send a synthetic vCard named “E2E Synthetic Contact” using reserved fictional number +1 202-555-0123. The address book is not read.',
      expectedTypes: ['vcard', 'multi_vcard'],
      content: () => syntheticVCard,
      options: { parseVCards: true },
      attest: Buffer.from(syntheticVCard, 'utf8'),
    },
    sticker: {
      preview: 'Send the locally generated test image as a sticker. No user file is read.',
      expectedTypes: ['sticker'],
      content: () => new MessageMedia('image/png', image.toString('base64'), 'whatsapp-agent-e2e-sticker.png', image.length),
      options: {
        sendMediaAsSticker: true,
        stickerName: 'WhatsApp Agent E2E',
        stickerAuthor: 'Local synthetic test',
        stickerCategories: ['✅'],
      },
      attest: image,
    },
  };
  const action = specifications[kind];
  if (!action) throw new Error('Unsupported rich test kind. Use image, document, location, contact, or sticker.');
  return {
    ...action,
    sha256: createHash('sha256').update(action.attest).digest('hex'),
  };
}

async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function hashNamedFiles(root, names) {
  const digest = createHash('sha256');
  for (const name of [...names].sort()) {
    digest.update(`file\0${name}\0`);
    digest.update(await readFile(path.join(root, name)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

async function hashDirectoryTree(root) {
  const digest = createHash('sha256');
  const walk = async (directory, relative = '') => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        digest.update(`directory\0${relativePath}\0`);
        await walk(absolutePath, relativePath);
      } else if (entry.isSymbolicLink()) {
        digest.update(`symlink\0${relativePath}\0${await readlink(absolutePath)}\0`);
      } else if (entry.isFile()) {
        digest.update(`file\0${relativePath}\0`);
        digest.update(await readFile(absolutePath));
        digest.update('\0');
      }
    }
  };
  await walk(root);
  return digest.digest('hex');
}

async function getRuntimeAttestation() {
  const backendStartupSourceSha256 = await startupBackendSourceSha256Promise;
  const backendCurrentDiskSourceSha256 = await hashNamedFiles(sourceRoot, runtimeSourceFiles);
  return {
    backendStartupSourceSha256,
    backendCurrentDiskSourceSha256,
    backendSourceMatchesStartup: backendStartupSourceSha256 === backendCurrentDiskSourceSha256,
    installedDependenciesStartupSha256: await startupInstalledDependenciesSha256Promise,
    messageApprovalHelperSha256: await hashFile(approvalHelper),
    baselineApprovalHelperSha256: await hashFile(`${paths.state}/native-baseline-approval`),
  };
}

async function getCompatibilityReport() {
  const whatsappWebVersion = client.pupPage
    ? await client.getWWebVersion().catch(() => null)
    : null;
  const browserVersion = client.pupBrowser
    ? await client.pupBrowser.version().catch(() => null)
    : null;
  const packageLockSha256 = createHash('sha256')
    .update(await readFile(packageLockPath))
    .digest('hex');
  const whatsappLock = appLock.packages['node_modules/whatsapp-web.js'];
  const attestation = await getRuntimeAttestation();
  const current = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    phase,
    runtime: {
      whatsappWebVersion,
      browserVersion,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    backend: {
      version: appPackage.version,
      whatsappWebJsVersion: whatsappPackage.version,
      whatsappWebJsSource: appPackage.dependencies['whatsapp-web.js'],
      whatsappWebJsResolved: whatsappLock.resolved,
      whatsappWebJsIntegrity: whatsappLock.integrity,
      packageLockSha256,
      ...attestation,
      mcpSdkVersion: appPackage.dependencies['@modelcontextprotocol/sdk'],
      qrcodeVersion: appPackage.dependencies.qrcode,
      zodVersion: appPackage.dependencies.zod,
    },
    controls: {
      headless: true,
      devtoolsTcpPort: false,
      privateUnixSocket: true,
      messagePreviewDefault: false,
      mediaDownloadApiUsed: false,
      automaticReplies: false,
      nativeUserAuthenticationForSend: true,
      sendRateLimitPerHour: 20,
      sendRateLimitPerDay: 100,
      dependencyAutoUpdate: false,
    },
  };
  const baseline = await readJson(paths.compatibilityBaseline, null);
  const comparable = {
    whatsappWebVersion: current.runtime.whatsappWebVersion,
    browserVersion: current.runtime.browserVersion,
    nodeVersion: current.runtime.nodeVersion,
    platform: current.runtime.platform,
    backendVersion: current.backend.version,
    whatsappWebJsVersion: current.backend.whatsappWebJsVersion,
    whatsappWebJsSource: current.backend.whatsappWebJsSource,
    whatsappWebJsResolved: current.backend.whatsappWebJsResolved,
    whatsappWebJsIntegrity: current.backend.whatsappWebJsIntegrity,
    packageLockSha256: current.backend.packageLockSha256,
    backendStartupSourceSha256: current.backend.backendStartupSourceSha256,
    backendCurrentDiskSourceSha256: current.backend.backendCurrentDiskSourceSha256,
    backendSourceMatchesStartup: current.backend.backendSourceMatchesStartup,
    installedDependenciesStartupSha256: current.backend.installedDependenciesStartupSha256,
    messageApprovalHelperSha256: current.backend.messageApprovalHelperSha256,
    baselineApprovalHelperSha256: current.backend.baselineApprovalHelperSha256,
    mcpSdkVersion: current.backend.mcpSdkVersion,
    qrcodeVersion: current.backend.qrcodeVersion,
    zodVersion: current.backend.zodVersion,
  };
  const drift = [];
  if (!baseline?.approved) {
    drift.push({ field: 'baseline', approved: null, current: 'missing' });
  } else {
    for (const [field, value] of Object.entries(comparable)) {
      if (baseline.approved[field] !== value) {
        drift.push({ field, approved: baseline.approved[field] ?? null, current: value });
      }
    }
  }
  return {
    ...current,
    approval: {
      
      baselinePath: paths.compatibilityBaseline,
      baselineApprovedAt: baseline?.approvedAt || null,
      drift,
      approvedForSending: drift.length === 0,
    },
  };
}

async function writeCompatibilitySnapshot() {
  const report = await getCompatibilityReport();
  await writeJsonAtomic(paths.compatibilitySnapshot, report);
  return report;
}

async function getCompatibilitySelfTest() {
  const report = await getCompatibilityReport();
  const state = await client.getState().catch(() => null);
  const pageProbe = client.pupPage
    ? await client.pupPage.evaluate(() => ({
        documentReady: document.readyState === 'complete',
        streamModelAvailable: Boolean(window.require?.('WAWebStreamModel')?.Stream),
        chatCollectionAvailable: Boolean(window.require?.('WAWebCollections')?.Chat),
        getChatAvailable: typeof window.WWebJS?.getChat === 'function',
        sendMessageAvailable: typeof window.WWebJS?.sendMessage === 'function',
        chatCount: Number(window.require?.('WAWebCollections')?.Chat?.getModelsArray?.().length || 0),
      })).catch(() => null)
    : null;
  return {
    passed: phase === 'ready' && state === 'CONNECTED' && report.backend.backendSourceMatchesStartup === true && Boolean(pageProbe?.documentReady) && Boolean(pageProbe?.streamModelAvailable) && Boolean(pageProbe?.chatCollectionAvailable) && Boolean(pageProbe?.getChatAvailable) && Boolean(pageProbe?.sendMessageAvailable),
    phase,
    state,
    pageProbe,
    compatibility: report,
    contentReturned: false,
  };
}

async function getSecurityAudit() {
  const checks = [];
  const checkPath = async (name, target, expectedMode, expectedType) => {
    try {
      const metadata = await lstat(target);
      const actualMode = (metadata.mode & 0o777).toString(8).padStart(4, '0');
      const typeOk = expectedType === 'directory'
        ? metadata.isDirectory()
        : expectedType === 'socket'
          ? metadata.isSocket()
          : metadata.isFile() && !metadata.isSymbolicLink();
      checks.push({
        name,
        passed: typeOk && metadata.uid === process.getuid() && actualMode === expectedMode,
        target,
        expectedMode,
        actualMode,
        ownerUid: metadata.uid,
        expectedOwnerUid: process.getuid(),
        expectedType,
      });
    } catch (error) {
      checks.push({ name, passed: false, target, error: error.message });
    }
  };

  await checkPath('profile-root', paths.root, '0700', 'directory');
  await checkPath('auth-profile', paths.auth, '0700', 'directory');
  await checkPath('state-root', paths.state, '0700', 'directory');
  await checkPath('control-socket', paths.socket, '0600', 'socket');
  await checkPath('message-approval-helper', approvalHelper, '0500', 'file');
  await checkPath('baseline-approval-helper', `${paths.state}/native-baseline-approval`, '0500', 'file');

  const browserArgs = client.pupBrowser?.process()?.spawnargs || [];
  checks.push({
    name: 'chrome-debug-transport',
    passed: browserArgs.includes('--remote-debugging-pipe') && !browserArgs.some((arg) => arg.startsWith('--remote-debugging-port')),
    remoteDebuggingPipe: browserArgs.includes('--remote-debugging-pipe'),
    remoteDebuggingPort: browserArgs.some((arg) => arg.startsWith('--remote-debugging-port')),
  });

  try {
    const { stdout } = await execFileAsync('/usr/bin/fdesetup', ['status'], { timeout: 5000 });
    checks.push({ name: 'filevault', passed: /FileVault is On\./i.test(stdout), status: stdout.trim() });
  } catch (error) {
    checks.push({ name: 'filevault', passed: false, error: error.message });
  }

  try {
    const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(process.pid), '-iTCP', '-sTCP:LISTEN'], { timeout: 5000 });
    checks.push({ name: 'backend-tcp-listener', passed: stdout.trim() === '', listenerPresent: stdout.trim() !== '' });
  } catch (error) {
    checks.push({ name: 'backend-tcp-listener', passed: error.code === 1 && !error.stdout?.trim(), listenerPresent: Boolean(error.stdout?.trim()) });
  }

  return {
    capturedAt: new Date().toISOString(),
    passed: checks.every((check) => check.passed),
    checks,
    contentReturned: false,
    residualRisk: 'Processes already running as the same macOS user can access user-owned profile data. Use a separate macOS account for a stronger OS boundary.',
  };
}

async function getChatSummaries({ includeLastMessage = false } = {}) {
  return await client.pupPage.evaluate((withPreview) => {
    const serialized = (value) => {
      if (!value) return '';
      if (typeof value === 'string') return value;
      return value._serialized ?? value.$1 ?? '';
    };
    return window
      .require('WAWebCollections')
      .Chat.getModelsArray()
      .map((chat) => {
        const summary = {
          id: serialized(chat.id),
          name: chat.formattedTitle || chat.name || '',
          isGroup: Boolean(chat.groupMetadata),
          unreadCount: Number(chat.unreadCount || 0),
          timestamp: Number(chat.t || 0),
          archived: Boolean(chat.archive),
          pinned: Boolean(chat.pin),
          muted: Boolean(chat.mute && chat.mute.expiration !== 0),
        };
        if (withPreview) {
          try {
            const messages = chat.msgs?.getModelsArray?.() || [];
            const last = messages[messages.length - 1];
            summary.lastMessage = last
              ? {
                  fromMe: Boolean(last.id?.fromMe),
                  timestamp: Number(last.t || 0),
                  type: last.type || 'unknown',
                  body: String(last.body || last.caption || '').slice(0, 800),
                  hasMedia: Boolean(last.mediaData || last.isMedia),
                }
              : null;
          } catch {
            summary.lastMessage = null;
          }
        }
        return summary;
      })
      .filter((chat) => Boolean(chat.id));
  }, includeLastMessage);
}

async function getMessagesDirect(chatId, limit) {
  return await client.pupPage.evaluate(async (target, maximum) => {
    const serialized = (value) => {
      if (!value) return '';
      if (typeof value === 'string') return value;
      return value._serialized ?? value.$1 ?? '';
    };
    const toMessage = (message) => {
      const type = message.type || 'unknown';
      const mediaLike = Boolean(message.mediaData || message.isMedia) || ['image', 'video', 'audio', 'ptt', 'sticker', 'document'].includes(type);
      const body = mediaLike
        ? String(message.caption || message.filename || '').slice(0, 12000)
        : String(message.body || message.caption || '').slice(0, 12000);
      return {
        id: serialized(message.id),
        chatId: serialized(message.id?.remote) || serialized(message.from),
        fromMe: Boolean(message.id?.fromMe),
        from: serialized(message.from),
        to: serialized(message.to),
        author: serialized(message.author) || null,
        timestamp: Number(message.t || 0),
        ack: Number(message.ack ?? 0),
        type,
        body,
        hasMedia: mediaLike,
        hasQuotedMessage: Boolean(message.quotedStanzaID || message.quotedMsg),
      };
    };
    const chat = await window.WWebJS.getChat(target, { getAsModel: false });
    if (!chat) throw new Error('Chat ID was not found.');
    const visible = (message) => !message.isNotification;
    let messages = (chat.msgs?.getModelsArray?.() || []).filter(visible);
    while (messages.length < maximum) {
      const earlier = await window
        .require('WAWebChatLoadMessages')
        .loadEarlierMsgs({ chat });
      if (!earlier?.length) break;
      messages = [...earlier.filter(visible), ...messages];
    }
    messages.sort((a, b) => Number(a.t || 0) - Number(b.t || 0));
    return messages.slice(-maximum).map(toMessage);
  }, chatId, limit);
}

function ackLabel(ack) {
  return ({
    '-1': 'error',
    0: 'pending',
    1: 'server',
    2: 'device',
    3: 'read',
    4: 'played',
  })[String(ack)] || 'unknown';
}

function rememberAcknowledgement(messageId, ack, observedAt = new Date().toISOString()) {
  const id = String(messageId || '');
  const numericAck = Number(ack);
  if (!id || !Number.isFinite(numericAck)) return [];
  const history = acknowledgementHistory.get(id) || [];
  if (history.at(-1)?.ack !== numericAck) {
    history.push({ ack: numericAck, ackLabel: ackLabel(numericAck), observedAt });
  }
  acknowledgementHistory.set(id, history.slice(-10));
  if (acknowledgementHistory.size > 500) {
    acknowledgementHistory.delete(acknowledgementHistory.keys().next().value);
  }
  return acknowledgementHistory.get(id);
}

async function getMessageStatusDirect(messageId) {
  const status = await client.pupPage.evaluate(async (target) => {
    const serialized = (value) => {
      if (!value) return '';
      if (typeof value === 'string') return value;
      return value._serialized ?? value.$1 ?? '';
    };
    const collection = window.require('WAWebCollections').Msg;
    const message = collection.get(target) || (await collection.getMessagesById([target]))?.messages?.[0];
    if (!message) return null;
    const type = message.type || 'unknown';
    const mediaLike = Boolean(message.mediaData || message.isMedia) || ['image', 'video', 'audio', 'ptt', 'sticker', 'document'].includes(type);
    return {
      id: serialized(message.id),
      chatId: serialized(message.id?.remote) || serialized(message.from),
      fromMe: Boolean(message.id?.fromMe),
      timestamp: Number(message.t || 0),
      ack: Number(message.ack ?? 0),
      type,
      body: mediaLike
        ? String(message.caption || message.filename || '').slice(0, 500)
        : String(message.body || message.caption || '').slice(0, 500),
      hasReaction: Boolean(message.hasReaction),
    };
  }, messageId);
  if (!status) throw new Error('Message ID was not found in the local WhatsApp Web cache.');
  const history = rememberAcknowledgement(status.id, status.ack);
  return { ...status, ackLabel: ackLabel(status.ack), acknowledgementHistory: history };
}

async function verifyRecentOutbound(chatId, { startedAt, body = null, expectedTypes = [] }) {
  const threshold = Math.floor(startedAt / 1000) - 5;
  const messages = await getMessagesDirect(chatId, 30);
  const match = [...messages].reverse().find((message) =>
    message.fromMe &&
    message.timestamp >= threshold &&
    (body === null || message.body === body) &&
    (expectedTypes.length === 0 || expectedTypes.includes(message.type)));
  if (!match) return null;
  const history = rememberAcknowledgement(match.id, match.ack);
  return { ...match, ackLabel: ackLabel(match.ack), acknowledgementHistory: history };
}

async function searchMessagesDirect(query, chatId, limit) {
  return await client.pupPage.evaluate(async (text, target, maximum) => {
    const serialized = (value) => {
      if (!value) return '';
      if (typeof value === 'string') return value;
      return value._serialized ?? value.$1 ?? '';
    };
    const { messages } = await window
      .require('WAWebCollections')
      .Msg.search(text, undefined, maximum, target || undefined);
    return messages.map((message) => ({
      id: serialized(message.id),
      chatId: serialized(message.id?.remote) || serialized(message.from),
      fromMe: Boolean(message.id?.fromMe),
      from: serialized(message.from),
      to: serialized(message.to),
      author: serialized(message.author) || null,
      timestamp: Number(message.t || 0),
      type: message.type || 'unknown',
      body: String(message.body || message.caption || '').slice(0, 12000),
      hasMedia: Boolean(message.mediaData || message.isMedia),
      hasQuotedMessage: Boolean(message.quotedStanzaID || message.quotedMsg),
    }));
  }, query, chatId, limit);
}

async function finalizeReady(source) {
  if (phase === 'ready') return;
  if (readyFinalizationInFlight) return await readyFinalizationInFlight;
  readyFinalizationInFlight = (async () => {
    const state = await client.getState();
    if (state !== 'CONNECTED') throw new Error(`Operational state is ${state || 'unknown'}, not CONNECTED.`);
    const chats = await getChatSummaries();
    if (!Array.isArray(chats)) throw new Error('Operational chat probe did not return an array.');

    if (authenticatedRecoveryTimer) clearTimeout(authenticatedRecoveryTimer);
    authenticatedRecoveryTimer = null;
    phase = 'ready';
    readyAt = new Date().toISOString();
    connectionState = state;
    await removeQr();
    await Promise.all([
      client.setAutoDownloadAudio(false),
      client.setAutoDownloadDocuments(false),
      client.setAutoDownloadPhotos(false),
      client.setAutoDownloadVideos(false),
    ]).catch((error) => log.debug('autodownload-config-warning', error.message));
    await client.sendPresenceUnavailable().catch(() => {});
    await publishState();
    await writeCompatibilitySnapshot();
    log.info('ready', `source=${source} chatCount=${chats.length}`);
// Install experimental call bridge on every ready path (library-event AND
    // operational-probe). Without this, operational-probe ready skips the
    // client.on('ready') handler and only installs on first accept attempt.
    try {
      const bridge = await installCallBridge(client.pupPage);
      const listener = await patchIncomingCallListener(client.pupPage);
      const probe = await probeCallBridge(client.pupPage);
      logJson('info', 'call-bridge-ready', {
        source,
        bridge,
        listener,
        probeSummary: {
          installed: probe?.installed,
          version: probe?.version,
          gating: probe?.gating || null,
          modules: probe?.modules
            ? Object.fromEntries(
              Object.entries(probe.modules).map(([k, v]) => [k, { ok: v.ok, error: v.error || null }]),
            )
            : null,
        },
      });
    } catch (bridgeError) {
      logJson('error', 'call-bridge-install-failed', { source, error: bridgeError.message });
    }

    if (!healthTimer) {
      healthTimer = setInterval(async () => {
        try {
          const current = await client.getState();
          connectionState = current;
          if (current !== 'CONNECTED') {
            log.error('health-check-failed', `state=${current || 'unknown'}`);
            await shutdown('health-check', 1);
            return;
          }
          await publishState();
        } catch (error) {
          log.error('health-check-failed', truncateText(error?.message || String(error), 300));
          await shutdown('health-check', 1);
        }
      }, 30000);
      healthTimer.unref();
    }
  })().finally(() => {
    readyFinalizationInFlight = null;
  });
  return await readyFinalizationInFlight;
}

function scheduleAuthenticatedRecovery(delayMs = 5000) {
  if (authenticatedRecoveryTimer || authenticatedRecoveryInFlight || phase !== 'authenticated') return;
  authenticatedRecoveryTimer = setTimeout(() => {
    authenticatedRecoveryTimer = null;
    void recoverAuthenticatedInitialization();
  }, delayMs);
}

async function recoverAuthenticatedInitialization() {
  if (authenticatedRecoveryInFlight || phase !== 'authenticated') return;
  if (authenticatedRecoveryAttempts >= 3) {
    log.error('authenticated-recovery-exhausted', 'listener initialization did not complete after three attempts');
    return;
  }
  authenticatedRecoveryInFlight = true;
  authenticatedRecoveryAttempts += 1;
  const attempt = authenticatedRecoveryAttempts;
  log.info('authenticated-recovery-start', `attempt=${attempt}/3`);
  try {
    await client.pupPage.waitForFunction(
      () => {
        const socket = window.require?.('WAWebSocketModel')?.Socket;
        const stream = window.require?.('WAWebStreamModel')?.Stream;
        return document.readyState === 'complete' && socket?.hasSynced === true && Boolean(stream);
      },
      { timeout: 60000 },
    );
    // The exposed onAppStateHasSynced callback is asynchronous. A main-frame
    // replacement can interrupt LoadUtils after it creates `window.WWebJS = {}`
    // but before its methods exist. Install the library's own utilities again
    // only after the new frame and Stream model are stable.
    await client.pupPage.evaluate(LoadUtils);
    await client.pupPage.waitForFunction(
      () =>
        typeof window.WWebJS?.getChats === 'function' &&
        typeof window.WWebJS?.getChat === 'function' &&
        typeof window.WWebJS?.sendMessage === 'function',
      { timeout: 30000 },
    );
    log.info('authenticated-recovery-utils-ready', `attempt=${attempt}/3`);
    await client.attachEventListeners();
    log.info('authenticated-recovery-listeners-ready', `attempt=${attempt}/3`);
    await finalizeReady('operational-probe');
  } catch (error) {
    log.error('authenticated-recovery-failed', `attempt=${attempt}/3 error=${truncateText(error?.message || String(error), 300)}`);
  } finally {
    authenticatedRecoveryInFlight = false;
    if (phase === 'authenticated') scheduleAuthenticatedRecovery(10000);
  }
}

async function ensureReady() {
  if (phase !== 'ready') {
    throw new Error(`WhatsApp backend is not ready (phase=${phase}). Pair the linked device first.`);
  }
}

async function resolveChat(target) {
  const value = String(target || '').trim();
  if (!value) throw new Error('A chat ID or exact chat name is required.');

  const chats = await getChatSummaries();
  if (value.includes('@')) {
    const chat = chats.find((candidate) => candidate.id === value);
    if (!chat) throw new Error('Chat ID was not found.');
    return chat;
  }

  const matches = chats.filter((chat) => String(chat.name || '').localeCompare(value, undefined, { sensitivity: 'accent' }) === 0);
  if (matches.length === 0) throw new Error('No chat matches that exact name. List chats first and use its ID.');
  if (matches.length > 1) throw new Error('Multiple chats have that name. List chats first and use the chat ID.');
  return matches[0];
}

async function recordOutcome(approvalId, outcome) {
  const sanitizedOutcome = { ...outcome };
  if (outcome.message) {
    sanitizedOutcome.message = {
      id: String(outcome.message.id || ''),
      timestamp: Number(outcome.message.timestamp || 0),
      ack: Number(outcome.message.ack ?? 0),
      ackLabel: String(outcome.message.ackLabel || ackLabel(Number(outcome.message.ack ?? 0))),
      type: String(outcome.message.type || 'unknown'),
      hasMedia: Boolean(outcome.message.hasMedia),
      acknowledgementHistory: Array.isArray(outcome.message.acknowledgementHistory)
        ? outcome.message.acknowledgementHistory.slice(-10)
        : [],
    };
  }
  const record = {
    approvalId,
    ...sanitizedOutcome,
    updatedAt: new Date().toISOString(),
  };
  sendOutcomes.set(approvalId, record);
  outcomeWriteQueue = outcomeWriteQueue.catch(() => {}).then(async () => {
    const recent = [...sendOutcomes.values()]
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
      .slice(-200);
    await writeJsonAtomic(paths.sendLedger, { version: 1, outcomes: recent });
  });
  await outcomeWriteQueue;
  return record;
}

async function requestNativeApproval(draft) {
  const helperMetadata = await lstat(approvalHelper);
  if (helperMetadata.isSymbolicLink() || !helperMetadata.isFile() || helperMetadata.uid !== process.getuid()) {
    throw new Error('Native approval helper failed ownership or file-type validation.');
  }
  if ((helperMetadata.mode & 0o022) !== 0) {
    throw new Error('Native approval helper must not be group- or world-writable.');
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(approvalHelper, [], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(true);
      else if (code === 2) resolve(false);
      else reject(new Error(`Native approval failed with exit ${code}: ${truncateText(stderr, 300)}`));
    });
    child.stdin.end(JSON.stringify({ target: draft.chatName || draft.chatId, text: draft.text, action: draft.action }));
  });
}

async function executeApprovedAction(draft) {
  const startedAt = Date.now();
  if (draft.action === 'send-text') {
    const sent = await client.sendMessage(draft.chatId, draft.text, {
      sendSeen: false,
      waitUntilMsgSent: true,
    });
    await client.sendPresenceUnavailable().catch(() => {});
    const verified = sent
      ? {
          id: sent.id?._serialized || '',
          timestamp: Number(sent.timestamp || 0),
          ack: Number(sent.ack ?? 0),
          ackLabel: ackLabel(Number(sent.ack ?? 0)),
          type: sent.type || 'chat',
        }
      : await verifyRecentOutbound(draft.chatId, { startedAt, body: draft.text, expectedTypes: ['chat'] });
    return verified
      ? { state: 'sent', action: draft.action, message: verified }
      : { state: 'outcome-unknown', action: draft.action, detail: 'WhatsApp returned no message object and the exact outbound text was not found in the recent chat cache.' };
  }

  if (draft.action === 'send-rich') {
    const specification = getSyntheticRichAction(draft.payload?.kind);
    if (specification.sha256 !== draft.payload?.sha256) {
      throw new Error('Synthetic asset attestation changed after preparation.');
    }
    const sent = await client.sendMessage(draft.chatId, specification.content(), {
      ...specification.options,
      sendSeen: false,
      waitUntilMsgSent: true,
    });
    await client.sendPresenceUnavailable().catch(() => {});
    const verified = sent
      ? {
          id: sent.id?._serialized || '',
          timestamp: Number(sent.timestamp || 0),
          ack: Number(sent.ack ?? 0),
          ackLabel: ackLabel(Number(sent.ack ?? 0)),
          type: sent.type || 'unknown',
        }
      : await verifyRecentOutbound(draft.chatId, { startedAt, expectedTypes: specification.expectedTypes });
    return verified
      ? { state: 'sent', action: draft.action, kind: draft.payload.kind, assetSha256: specification.sha256, message: verified }
      : { state: 'outcome-unknown', action: draft.action, kind: draft.payload.kind, assetSha256: specification.sha256, detail: 'WhatsApp returned no message object and no matching outbound message was found in the recent chat cache.' };
  }

  if (draft.action === 'mark-read') {
    const marked = await client.sendSeen(draft.chatId);
    await client.sendPresenceUnavailable().catch(() => {});
    return { state: marked === false ? 'outcome-unknown' : 'completed', action: draft.action, marked: marked !== false };
  }

  if (draft.action === 'react') {
    const before = await getMessageStatusDirect(draft.payload.messageId);
    if (before.chatId !== draft.chatId) throw new Error('The approved reaction message no longer belongs to the approved chat.');
    await client.sendReaction(draft.payload.messageId, draft.payload.reaction);
    await client.sendPresenceUnavailable().catch(() => {});
    const after = await getMessageStatusDirect(draft.payload.messageId).catch(() => null);
    return { state: 'completed', action: draft.action, reaction: draft.payload.reaction, message: after || before };
  }

  throw new Error(`Unsupported approved action: ${draft.action}`);
}

async function dispatch(method, params = {}) {
  if (method === 'status') {
    return {
      phase,
      ready: phase === 'ready',
      connectionState,
      
      qrAvailable: phase === 'pairing',
      qrPath: phase === 'pairing' ? paths.qrFile : null,
      qrUpdatedAt,
      readyAt,
      pid: process.pid,
    };
  }

  if (method === 'compatibility') {
    return await getCompatibilityReport();
  }

  if (method === 'compatibilitySelfTest') {
    return await getCompatibilitySelfTest();
  }

  if (method === 'securityAudit') {
    return await getSecurityAudit();
  }

  // Call-related methods (experimental voice-bot)
  if (method === 'getLastCall') {
    const safeLastCall = lastCall
      ? {
          id: lastCall.id,
          from: lastCall.from,
          isVideo: lastCall.isVideo,
          isGroup: lastCall.isGroup,
          canHandleLocally: lastCall.canHandleLocally,
          webClientShouldHandle: lastCall.webClientShouldHandle,
          timestamp: lastCall.timestamp,
        }
      : null;
    return {
      lastCall: safeLastCall,
      activeBotCall: activeBotCall || null,
      autoAcceptCalls,
      botAudioPath,
      message: safeLastCall ? undefined : 'No incoming calls detected since daemon started.',
    };
  }


  if (method === 'deepProbeVoipStack') {
    try {
      await installCallBridge(client.pupPage);
      return await deepProbeVoipStack(client.pupPage);
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  if (method === 'getCallBotConfig') {
    return {
      autoAcceptCalls,
      botAudioInject,
      botHangupAfterAudio,
      botAudioPath,
      botHangupPaddingMs,
      headless: voiceBotHeadless,
      toggles: {
        autoAccept: 'WHATSAPP_AUTO_ACCEPT_CALLS=0 to disable auto-answer (detect only). Default on.',
        audioInject: 'WHATSAPP_BOT_AUDIO_INJECT=0 to accept without greeting inject. Default on.',
        hangupAfterAudio: 'WHATSAPP_BOT_HANGUP_AFTER_AUDIO=0 to keep call open after accept/play. Default on.',
        audioFile: 'WHATSAPP_BOT_AUDIO=/abs/path.wav (PCM). Restart daemon after change.',
        hangupPaddingMs: 'WHATSAPP_BOT_HANGUP_PADDING_MS=800 (ms after audio before hangup).',
        headless: 'WHATSAPP_HEADLESS=1 for invisible Chrome (LaunchAgent default).',
      },
      canChangeAudio: 'Set WHATSAPP_BOT_AUDIO to another WAV (PCM) path and restart the daemon. m4a/mp3 not supported by Chrome fake mic.',
      disableAutoAccept: 'Set WHATSAPP_AUTO_ACCEPT_CALLS=0 and restart the daemon.',
      disableAudioInject: 'Set WHATSAPP_BOT_AUDIO_INJECT=0 and restart the daemon.',
      forceHeadless: 'Set WHATSAPP_HEADLESS=1 to force headless Chrome (no visible window).',
      note: 'Call accept: VoIP-first stack.acceptCall(unmute,enableVideo) + WebAudio mic inject (bridge v6+). No raw WAWap accept stanza.',
      research: {
        wwebjs_201825: 'https://github.com/wwebjs/whatsapp-web.js/pull/201825',
        wwebjs_201881: 'https://github.com/wwebjs/whatsapp-web.js/pull/201881',
        wppconnect_2521: 'https://github.com/wppconnect-team/wppconnect-server/pull/2521',
      },
    };
  }

  if (method === 'probeCallBridge') {
    try {
      await installCallBridge(client.pupPage);
      await patchIncomingCallListener(client.pupPage);
      return await probeCallBridge(client.pupPage);
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (method === 'rejectCall') {
    if (!lastCall) return { success: false, error: 'No active call to reject.' };
    try {
      const rejected = await rejectActiveCall(lastCall);
      return rejected;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (method === 'exploreCallApi') {
    try {
      const legacy = await inspectCallApi();
      const bridge = await probeCallBridge(client.pupPage);
      return { legacy, bridge };
    } catch (err) {
      return { error: err.message };
    }
  }

  if (method === 'acceptCall') {
    if (!lastCall) return { success: false, error: 'No active call to accept.' };
    try {
      const result = await acceptIncomingCall(lastCall, { hangupAfterAudio: params.hangupAfterAudio !== false });
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (method === 'hangupCall') {
    try {
      const result = await hangupActiveCall();
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (method === 'getChatLockSecretStatus') {
    const secret = await loadChatLockSecretCode();
    return {
      accountId,
      configured: Boolean(secret),
      secretsPath: paths.secretsFile,
      // Never return the actual secret via RPC.
      source: secret ? 'secrets.json' : null,
    };
  }

  if (method === 'setChatLockSecret') {
    const code = String(params.code || params.secretCode || params.chatLockSecretCode || '').trim();
    if (!code) return { success: false, error: 'code is required' };
    if (code.length < 4 || code.length > 64) {
      return { success: false, error: 'code length must be between 4 and 64 characters' };
    }
    await ensurePrivateDirectories(paths);
    const existing = await readJson(paths.secretsFile, {});
    const next = {
      ...existing,
      accountId: accountId || existing.accountId || null,
      chatLockSecretCode: code,
      updatedAt: new Date().toISOString(),
      note: existing.note || 'WhatsApp Chat Lock / Secret Code for locked chats on this linked account.',
    };
    await writeJsonAtomic(paths.secretsFile, next, 0o600);
    cachedChatLockSecret = code;
    return {
      success: true,
      accountId,
      configured: true,
      secretsPath: paths.secretsFile,
      // Never echo the secret back.
    };
  }

  if (method === 'unlockChatLock') {
    try {
      const result = await unlockChatLockPrompt({
        code: params.code || params.secretCode || null,
        // Only type when a real secret-code field is visible.
        force: Boolean(params.force),
      });
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (method === 'clearSearch') {
    try {
      const result = await clearWhatsAppSearchBox();
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  await ensureReady();

  if (method === 'listChats') {
    const limit = Math.min(Math.max(Number(params.limit || 50), 1), 200);
    const unreadOnly = Boolean(params.unreadOnly);
    const includeArchived = params.includeArchived !== false;
    const includeLastMessage = Boolean(params.includeLastMessage);
    let chats = await getChatSummaries({ includeLastMessage });
    if (unreadOnly) chats = chats.filter((chat) => Number(chat.unreadCount || 0) > 0);
    if (!includeArchived) chats = chats.filter((chat) => !chat.archived);
    chats.sort((a, b) => Number(b.timestamp || b.lastMessage?.timestamp || 0) - Number(a.timestamp || a.lastMessage?.timestamp || 0));
    return chats.slice(0, limit);
  }

  if (method === 'getMessages') {
    const chat = await resolveChat(params.chat);
    const limit = Math.min(Math.max(Number(params.limit || 30), 1), 200);
    const messages = await getMessagesDirect(chat.id, limit);
    return {
      chat: { id: chat.id, name: chat.name || '', isGroup: Boolean(chat.isGroup) },
      messages,
    };
  }

  if (method === 'searchMessages') {
    const query = String(params.query || '').trim();
    if (!query) throw new Error('A non-empty search query is required.');
    const limit = Math.min(Math.max(Number(params.limit || 50), 1), 100);
    let chatId = null;
    if (params.chat) {
      const chat = await resolveChat(params.chat);
      chatId = chat.id;
    }
    return await searchMessagesDirect(query, chatId, limit);
  }

  if (method === 'messageStatus') {
    const messageId = String(params.messageId || '').trim();
    if (!messageId) throw new Error('A message ID is required.');
    return await getMessageStatusDirect(messageId);
  }

  // Direct send without approval - for trusted web UI only
  if (method === 'directSend') {
    assertSendRateLimit();
    const text = String(params.text || '').trim();
    if (!text) throw new Error('Message text cannot be empty.');
    if (text.length > 10000) throw new Error('Message text exceeds the 10,000-character safety limit.');
    const chat = await resolveChat(params.chat);
    const sent = await client.sendMessage(chat.id, text, {
      sendSeen: false,
      waitUntilMsgSent: true,
    });
    await client.sendPresenceUnavailable().catch(() => {});
    return sent
      ? {
          success: true,
          message: {
            id: sent.id?._serialized || '',
            timestamp: Number(sent.timestamp || 0),
            ack: Number(sent.ack ?? 0),
            type: sent.type || 'chat',
          },
        }
      : { success: true, message: null, detail: 'Message sent but no confirmation object returned.' };
  }

  if (method === 'prepareSend') {
    assertSendRateLimit();
    const text = String(params.text || '').trim();
    if (!text) throw new Error('Message text cannot be empty.');
    if (text.length > 10000) throw new Error('Message text exceeds the 10,000-character safety limit.');
    const chat = await resolveChat(params.chat);
    const prepared = drafts.prepare({
      chatId: chat.id,
      chatName: chat.name || '',
      text,
      action: 'send-text',
    });
    await recordOutcome(prepared.approvalId, { state: 'prepared', action: prepared.action, characters: text.length });
    return {
      approvalId: prepared.approvalId,
      target: { id: prepared.chatId, name: prepared.chatName },
      text: prepared.text,
      expiresAt: new Date(prepared.expiresAt).toISOString(),
      warning: 'Nothing has been sent. Show this exact preview to the user and wait for explicit approval. Final authorization requires the immutable native preview plus Touch ID or the macOS login password.',
    };
  }

  if (method === 'prepareRichTest') {
    assertSendRateLimit();
    const kind = String(params.kind || '').trim();
    const chat = await resolveChat(params.chat);
    const specification = getSyntheticRichAction(kind);
    const preview = `${specification.preview}\nSynthetic asset SHA-256: ${specification.sha256}`;
    const prepared = drafts.prepare({
      chatId: chat.id,
      chatName: chat.name || '',
      text: preview,
      action: 'send-rich',
      payload: { kind, sha256: specification.sha256 },
    });
    await recordOutcome(prepared.approvalId, { state: 'prepared', action: prepared.action, kind, assetSha256: specification.sha256 });
    return {
      approvalId: prepared.approvalId,
      action: prepared.action,
      kind,
      target: { id: prepared.chatId, name: prepared.chatName },
      preview,
      assetSha256: specification.sha256,
      expiresAt: new Date(prepared.expiresAt).toISOString(),
      warning: 'Nothing has been sent. Show this exact preview and SHA-256 to the user, wait for explicit approval, then request the immutable native Touch ID approval.',
    };
  }

  if (method === 'prepareMarkRead') {
    const chat = await resolveChat(params.chat);
    const preview = `Mark chat as read (send a seen receipt).\nCurrent unread count: ${Number(chat.unreadCount || 0)}\nThis is externally visible when read receipts are enabled.`;
    const prepared = drafts.prepare({
      chatId: chat.id,
      chatName: chat.name || '',
      text: preview,
      action: 'mark-read',
    });
    await recordOutcome(prepared.approvalId, { state: 'prepared', action: prepared.action });
    return {
      approvalId: prepared.approvalId,
      action: prepared.action,
      target: { id: prepared.chatId, name: prepared.chatName },
      preview,
      expiresAt: new Date(prepared.expiresAt).toISOString(),
      warning: 'Nothing has been marked read. Show this exact preview to the user and wait for explicit approval before requesting Touch ID.',
    };
  }

  if (method === 'prepareReaction') {
    const chat = await resolveChat(params.chat);
    const messageId = String(params.messageId || '').trim();
    const reaction = String(params.reaction || '');
    if (!['✅', '👍', '❤️', '😂', '😮', '😢', '🙏'].includes(reaction)) {
      throw new Error('Reaction must be one of: ✅, 👍, ❤️, 😂, 😮, 😢, 🙏.');
    }
    const message = await getMessageStatusDirect(messageId);
    if (message.chatId !== chat.id) throw new Error('The message ID does not belong to the selected chat.');
    const previewBody = message.body ? `\nMessage preview: ${truncateText(message.body, 300)}` : '';
    const preview = `React ${reaction} to the exact WhatsApp message ID below.\nMessage ID: ${message.id}\nDirection: ${message.fromMe ? 'outbound' : 'incoming'}${previewBody}`;
    const prepared = drafts.prepare({
      chatId: chat.id,
      chatName: chat.name || '',
      text: preview,
      action: 'react',
      payload: { messageId: message.id, reaction },
    });
    await recordOutcome(prepared.approvalId, { state: 'prepared', action: prepared.action, messageId: message.id, reaction });
    return {
      approvalId: prepared.approvalId,
      action: prepared.action,
      target: { id: prepared.chatId, name: prepared.chatName },
      preview,
      expiresAt: new Date(prepared.expiresAt).toISOString(),
      warning: 'No reaction has been sent. Show this exact preview to the user and wait for explicit approval before requesting Touch ID.',
    };
  }

  if (method === 'requestLocalApproval') {
    if (sendApprovalInFlight) throw new Error('Another native send approval is already in progress.');
    sendApprovalInFlight = true;
    const approvalId = String(params.approvalId || '');
    try {
      assertSendRateLimit();
      const draft = drafts.beginApproval(approvalId);
      await recordOutcome(approvalId, { state: 'awaiting-local-approval', action: draft.action, characters: draft.text.length });
      let approved;
      try {
        approved = await requestNativeApproval(draft);
      } catch (error) {
        drafts.cancel(approvalId);
        await recordOutcome(approvalId, { state: 'approval-error', action: draft.action, characters: draft.text.length, detail: truncateText(error.message, 300) });
        throw error;
      }
      if (!approved) {
        drafts.cancel(approvalId);
        return await recordOutcome(approvalId, { state: 'declined', action: draft.action, characters: draft.text.length });
      }
      assertSendRateLimit();
      const approvedDraft = drafts.consumeApproved(approvalId);
      await recordOutcome(approvalId, { state: 'sending', action: approvedDraft.action, characters: approvedDraft.text.length });
      try {
        const result = await executeApprovedAction(approvedDraft);
        return await recordOutcome(approvalId, { ...result, characters: approvedDraft.text.length });
      } catch (error) {
        return await recordOutcome(approvalId, {
          state: 'outcome-unknown',
          action: approvedDraft.action,
          characters: approvedDraft.text.length,
          detail: truncateText(error.message, 300),
        });
      }
    } finally {
      sendApprovalInFlight = false;
    }
  }

  if (method === 'getSendOutcome') {
    const approvalId = String(params.approvalId || '');
    const outcome = sendOutcomes.get(approvalId);
    if (!outcome) throw new Error('No send outcome exists for that approval ID.');
    return outcome;
  }

  throw new Error(`Unknown backend method: ${method}`);
}

async function handleConnection(socket) {
  activeSockets.add(socket);
  socket.setTimeout(35000, () => socket.destroy());
  socket.once('close', () => activeSockets.delete(socket));
  socket.setEncoding('utf8');
  let buffer = '';
  let handled = false;

  socket.on('data', async (chunk) => {
    if (handled) return;
    buffer += chunk;
    if (buffer.length > 1024 * 1024) {
      handled = true;
      socket.end(`${JSON.stringify({ ok: false, error: 'Request exceeded the 1 MiB safety limit.' })}\n`);
      return;
    }
    const newline = buffer.indexOf('\n');
    if (newline === -1) return;
    handled = true;
    try {
      const request = JSON.parse(buffer.slice(0, newline));
      log.debug('rpc-request', `method=${request.method || 'missing'}`);
      const result = await dispatch(request.method, request.params);
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    } catch (error) {
      log.error('rpc-failed', truncateText(error.message, 300));
      socket.end(`${JSON.stringify({ ok: false, error: error.message || 'Request failed.' })}\n`);
    }
  });
}

client.on('qr', async (qr) => {
  const generation = ++qrGeneration;
  try {
    phase = 'pairing';
    qrUpdatedAt = new Date().toISOString();
    const image = await QRCode.toBuffer(qr, { width: 640, margin: 2, errorCorrectionLevel: 'M' });
    if (generation !== qrGeneration || phase !== 'pairing') return;
    await writeFileAtomic(paths.qrFile, image, 0o600);
    await publishState();
    log.info('pairing-qr-ready', `path=${paths.qrFile}`);
  } catch (error) {
    log.error('pairing-qr-failed', error.message);
  }
});

client.on('authenticated', async () => {
  qrGeneration += 1;
  phase = 'authenticated';
  await removeQr();
  await publishState();
  log.info('authenticated', 'linked-device credentials accepted');
  scheduleAuthenticatedRecovery();
});

client.on('ready', async () => {
  try {
    // Enable desktop notifications early so incoming-call UI is more likely to render.
    const permission = await ensureDesktopNotificationPermission();
    const notif = await enableDesktopNotifications();
    logJson('info', 'ready-enable-notifications', { permission, notif });

    // Call bridge install lives in finalizeReady so operational-probe ready
    // (the common path) also gets the VoIP helpers + activeCall listener.
    await finalizeReady('library-event');
  } catch (error) {
    log.error('ready-finalization-failed', truncateText(error?.message || String(error), 300));
    phase = 'authenticated';
    await publishState();
    scheduleAuthenticatedRecovery();
  }
});

client.on('message_ack', (message, ack) => {
  const messageId = message?.id?._serialized || '';
  rememberAcknowledgement(messageId, ack);
  log.debug('message-ack', `messageId=${messageId || 'unknown'} ack=${Number(ack)} label=${ackLabel(Number(ack))}`);
});

client.on('auth_failure', async (message) => {
  qrGeneration += 1;
  phase = 'auth-failure';
  await removeQr();
  await publishState({ error: truncateText(message, 300) });
  log.error('auth-failure', truncateText(message, 300));
});

client.on('change_state', async (state) => {
  connectionState = state;
  await publishState();
  log.debug('connection-state', state);
});

client.on('disconnected', async (reason) => {
  phase = 'disconnected';
  connectionState = String(reason);
  qrGeneration += 1;
  await removeQr();
  await publishState();
  log.error('disconnected', String(reason));
  await shutdown('disconnected', 1);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getWavDurationMs(filePath) {
  try {
    const { stdout } = await execFileAsync('afinfo', [filePath], { timeout: 5000 });
    const match = String(stdout).match(/estimated duration:\s*([0-9.]+)\s*sec/i);
    if (!match) return 10000;
    return Math.max(1000, Math.round(Number(match[1]) * 1000));
  } catch {
    return 10000;
  }
}

async function inspectCallApi() {
  return await client.pupPage.evaluate(() => {
    const info = {};
    try {
      const CC = window.require('WAWebCallCollection');
      info.WAWebCallCollection = {
        keys: CC ? Object.keys(CC).slice(0, 30) : null,
        pendingOffers: CC?.pendingOffers,
        isInConnectedCall: CC?.isInConnectedCall,
        lastActiveCall: CC?.lastActiveCall ? {
          id: CC.lastActiveCall.id,
          peerJid: CC.lastActiveCall.peerJid,
          state: CC.lastActiveCall.state,
          isVideo: CC.lastActiveCall.isVideo,
          canHandleLocally: CC.lastActiveCall.canHandleLocally,
          webClientShouldHandle: CC.lastActiveCall.webClientShouldHandle,
          proto: Object.getOwnPropertyNames(Object.getPrototypeOf(CC.lastActiveCall)).slice(0, 40),
        } : null,
      };
    } catch (e) {
      info.WAWebCallCollection = e.message;
    }

    try {
      const Call = window.Store?.Call;
      if (Call) {
        info.StoreCallModels = (Call.getModelsArray?.() || []).map((c) => ({
          id: c.id,
          peerJid: c.peerJid,
          state: c.state,
          canHandleLocally: c.canHandleLocally,
          webClientShouldHandle: c.webClientShouldHandle,
          allMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(c)),
        }));
      }
    } catch (e) {
      info.StoreCall = e.message;
    }

    // Scan visible call controls so accept/hangup selectors can be adapted.
    info.uiButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((el) => ({
        tag: el.tagName,
        ariaLabel: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        text: (el.innerText || el.textContent || '').trim().slice(0, 80),
        dataTestId: el.getAttribute('data-testid') || '',
      }))
      .filter((btn) => /accept|answer|decline|reject|end|hang|call|terima|tolak|akhiri/i.test(`${btn.ariaLabel} ${btn.title} ${btn.text} ${btn.dataTestId}`))
      .slice(0, 30);

    return info;
  });
}

async function focusWhatsAppWindow({ clickBody = false } = {}) {
  // Bring the Chrome tab forward only.
  // NEVER click document.body by default — that dismisses WhatsApp's incoming-call toast/popup.
  try {
    if (client.pupPage?.bringToFront) await client.pupPage.bringToFront();
  } catch {
    // ignore
  }
  try {
    await client.pupPage.evaluate((shouldClickBody) => {
      window.focus?.();
      if (shouldClickBody) document.body?.click?.();
    }, clickBody);
  } catch {
    // ignore
  }
}

async function ensureDesktopNotificationPermission() {
  // Grant browser-level Notification permission for web.whatsapp.com so the
  // in-page "Turn on" flow can complete (and call toasts can render).
  const result = { override: null, permission: null };
  try {
    const page = client.pupPage;
    if (!page) return { ...result, error: 'no page' };
    const origin = 'https://web.whatsapp.com';
    const context = page.browserContext?.() || page.browser()?.defaultBrowserContext?.();
    if (context?.overridePermissions) {
      await context.overridePermissions(origin, ['notifications', 'microphone', 'camera']);
      result.override = 'granted-notifications-microphone-camera';
    }
    result.permission = await page.evaluate(async () => {
      try {
        if (!('Notification' in window)) return 'unsupported';
        if (Notification.permission === 'granted') return 'already-granted';
        if (Notification.permission === 'denied') return 'denied';
        const next = await Notification.requestPermission();
        return next;
      } catch (error) {
        return `error:${error.message}`;
      }
    });
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

async function loadChatLockSecretCode() {
  if (cachedChatLockSecret !== undefined) return cachedChatLockSecret;
  try {
    const secrets = await readJson(paths.secretsFile, null);
    const code = String(
      secrets?.chatLockSecretCode
      || secrets?.secretCode
      || secrets?.chatLockCode
      || '',
    ).trim();
    cachedChatLockSecret = code || null;
  } catch {
    cachedChatLockSecret = null;
  }
  return cachedChatLockSecret;
}

async function clearWhatsAppSearchBox() {
  if (!client.pupPage) return { cleared: false, reason: 'no page' };
  return await client.pupPage.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect?.() || { width: 0, height: 0 };
      return rect.width > 0 && rect.height > 0;
    };
    const labelOf = (el) => normalize([
      el.getAttribute('aria-label') || '',
      el.getAttribute('placeholder') || '',
      el.getAttribute('data-testid') || '',
      el.getAttribute('title') || '',
    ].join(' '));

    const searchInputs = Array.from(document.querySelectorAll('input, [contenteditable="true"], [role="textbox"]'))
      .filter(isVisible)
      .filter((el) => /search|cari/.test(labelOf(el)));

    let cleared = 0;
    for (const el of searchInputs) {
      try {
        el.focus();
        if ('value' in el) {
          const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          if (proto?.set) proto.set.call(el, '');
          else el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.textContent = '';
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteContentBackward' }));
        }
        cleared += 1;
      } catch {
        // ignore
      }
    }

    // Click the X clear button if present.
    for (const el of document.querySelectorAll('button, [role="button"], span[data-icon="x"], span[data-icon="x-refreshed"]')) {
      if (!isVisible(el)) continue;
      const label = labelOf(el);
      const icon = el.getAttribute('data-icon') || el.querySelector?.('[data-icon]')?.getAttribute('data-icon') || '';
      if (/clear|close search|x-refreshed|^x$/.test(`${label} ${icon}`)) {
        try { el.click(); } catch { /* ignore */ }
      }
    }
    return { cleared, count: searchInputs.length };
  });
}

async function unlockChatLockPrompt({ code = null, force = false } = {}) {
  const secret = String(code || await loadChatLockSecretCode() || '').trim();
  if (!secret) {
    return {
      success: false,
      configured: false,
      error: 'No chat-lock secret configured. Save chatLockSecretCode in secrets.json first.',
    };
  }

  if (!client.pupPage) {
    return { success: false, configured: true, error: 'WhatsApp page not ready.' };
  }

  // Detect ONLY a real chat-lock / secret-code prompt. Never fall back to the search box.
  const detected = await client.pupPage.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const body = normalize(document.body?.innerText || '').toLowerCase();
    const looksLocked = (
      /enter your secret code/.test(body)
      || /secret code/.test(body)
      || /chat lock/.test(body)
      || /kode rahasia/.test(body)
      || /masukkan kode/.test(body)
    );

    const isVisible = (el) => {
      const rect = el.getBoundingClientRect?.() || { width: 0, height: 0 };
      return rect.width > 0 && rect.height > 0;
    };
    const labelOf = (el) => normalize([
      el.getAttribute('aria-label') || '',
      el.getAttribute('placeholder') || '',
      el.getAttribute('name') || '',
      el.getAttribute('autocomplete') || '',
      el.getAttribute('data-testid') || '',
      el.getAttribute('title') || '',
    ].join(' '));

    const inputs = Array.from(document.querySelectorAll('input, [contenteditable="true"], [role="textbox"]'))
      .filter(isVisible)
      .map((el) => {
        const label = labelOf(el);
        const type = (el.getAttribute('type') || '').toLowerCase();
        const isSearch = /search|cari|start a new chat/.test(label.toLowerCase());
        const passwordLike = (
          type === 'password'
          || /password|secret|code|pin|passcode|kode|rahasia|chat.?lock/i.test(label)
        );
        return {
          tag: el.tagName,
          type,
          label: label.slice(0, 120),
          isSearch,
          passwordLike,
        };
      })
      .slice(0, 30);

    return {
      looksLocked,
      bodySnippet: normalize(document.body?.innerText || '').slice(0, 400),
      inputs,
      secretInputs: inputs.filter((i) => i.passwordLike && !i.isSearch),
    };
  });

  const hasSecretInput = (detected.secretInputs || []).length > 0;
  if (!detected.looksLocked && !hasSecretInput) {
    // Safety: if previous runs polluted the search box, clear it.
    await clearWhatsAppSearchBox();
    return {
      success: false,
      configured: true,
      skipped: true,
      reason: 'No chat-lock / secret-code prompt detected.',
      detected,
    };
  }

  // force=true still requires a secret-looking field; never type into search.
  if (!hasSecretInput) {
    return {
      success: false,
      configured: true,
      skipped: true,
      reason: 'Chat-lock text seen but no secret-code input field found.',
      detected,
    };
  }

  // Fill EXACTLY once via the page (no extra Puppeteer keyboard.type).
  const typed = await client.pupPage.evaluate((secretCode) => {
    const result = {
      filled: false,
      submitted: false,
      matched: null,
      clicks: [],
      errors: [],
    };

    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect?.() || { width: 0, height: 0 };
      return rect.width > 0 && rect.height > 0;
    };
    const labelOf = (el) => normalize([
      el.getAttribute('aria-label') || '',
      el.getAttribute('placeholder') || '',
      el.getAttribute('name') || '',
      el.getAttribute('autocomplete') || '',
      el.getAttribute('data-testid') || '',
      el.getAttribute('title') || '',
    ].join(' '));

    const candidates = Array.from(document.querySelectorAll(
      'input, [contenteditable="true"], [role="textbox"]',
    )).filter(isVisible);

    const target = candidates.find((el) => {
      const label = labelOf(el).toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (/search|cari|start a new chat/.test(label)) return false;
      return type === 'password'
        || /secret|code|pin|passcode|kode|rahasia|chat.?lock/.test(label);
    }) || null;

    if (!target) {
      result.errors.push('No secret-code input field found (refusing search box fallback)');
      return result;
    }

    result.matched = {
      tag: target.tagName,
      type: target.getAttribute('type') || '',
      label: labelOf(target).slice(0, 120),
    };

    try {
      target.focus();
      target.click();
      // Clear first so we never append/double-fill.
      if ('value' in target) {
        const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
          || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value');
        if (proto?.set) {
          proto.set.call(target, '');
          target.dispatchEvent(new Event('input', { bubbles: true }));
          proto.set.call(target, secretCode);
        } else {
          target.value = secretCode;
        }
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        target.textContent = '';
        target.textContent = secretCode;
        target.dispatchEvent(new InputEvent('input', { bubbles: true, data: secretCode, inputType: 'insertText' }));
      }
      result.filled = true;
    } catch (error) {
      result.errors.push(`fill-failed: ${error.message}`);
      return result;
    }

    // Submit once: prefer Unlock/Continue buttons, else single Enter.
    const submitMatchers = [
      /^unlock$/i,
      /^continue$/i,
      /^ok$/i,
      /^next$/i,
      /^enter$/i,
      /^buka$/i,
      /^lanjut$/i,
      /unlock chat/i,
      /open chat/i,
    ];
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], div[role="button"]'))
      .filter(isVisible);
    for (const btn of buttons) {
      const label = labelOf(btn);
      if (!submitMatchers.some((re) => re.test(label))) continue;
      try {
        btn.click();
        result.clicks.push(label.slice(0, 80));
        result.submitted = true;
        break;
      } catch (error) {
        result.errors.push(`submit-click-failed: ${error.message}`);
      }
    }

    if (!result.submitted) {
      try {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        if (typeof target.form?.requestSubmit === 'function') target.form.requestSubmit();
        result.submitted = true;
      } catch (error) {
        result.errors.push(`enter-failed: ${error.message}`);
      }
    }

    return result;
  }, secret);

  await sleep(800);
  const after = await client.pupPage.evaluate(() => {
    const body = (document.body?.innerText || '').toLowerCase();
    return {
      stillLocked: (
        /enter your secret code/.test(body)
        || /secret code/.test(body)
        || /chat lock/.test(body)
        || /kode rahasia/.test(body)
      ),
      bodySnippet: (document.body?.innerText || '').slice(0, 300),
    };
  });

  const success = Boolean(typed?.filled) && !after.stillLocked;
  logJson('info', 'chat-lock-unlock-attempt', {
    configured: true,
    filled: typed?.filled || false,
    submitted: typed?.submitted || false,
    stillLocked: after.stillLocked,
    matched: typed?.matched || null,
    clicks: typed?.clicks || [],
    force: Boolean(force),
  });

  return {
    success,
    configured: true,
    filled: Boolean(typed?.filled),
    submitted: Boolean(typed?.submitted),
    stillLocked: Boolean(after.stillLocked),
    detected,
    typed: {
      filled: typed?.filled || false,
      submitted: typed?.submitted || false,
      matched: typed?.matched || null,
      clicks: typed?.clicks || [],
      errors: typed?.errors || [],
    },
    after,
  };
}

async function enableDesktopNotifications() {
  // CORRECT behavior: click "Turn on" so WhatsApp enables desktop notifications.
  // Do NOT click Close / Not now — that keeps notifications off and can hide call UI.
  return await client.pupPage.evaluate(() => {
    const result = {
      clicked: [],
      candidates: [],
      permission: (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'),
    };

    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const textOf = (el) => normalize(el.innerText || el.textContent || '');
    const labelOf = (el) => normalize([
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-testid') || '',
      el.innerText || '',
      el.textContent || '',
    ].join(' '));

    // Prefer the butterbar "Turn on" control when present.
    const targets = [];
    const butterbar = document.querySelector('[data-testid="chat-butterbar"]');
    if (butterbar) {
      const btn = butterbar.querySelector('button, [role="button"]') || butterbar;
      targets.push(btn);
    }
    for (const el of document.querySelectorAll('button, [role="button"], div[role="button"]')) {
      targets.push(el);
    }

    const seen = new Set();
    for (const el of targets) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect?.() || { width: 0, height: 0 };
      if (!(rect.width > 0 && rect.height > 0)) continue;

      const text = textOf(el);
      const label = labelOf(el) || text;
      if (!label) continue;

      // Avoid matching "Turn on" buried inside long unrelated labels without the notification context.
      const isExactTurnOn = /^turn on$/i.test(text) || /^turn on$/i.test(label);
      const isNotificationTurnOn = (
        /\bturn on\b/i.test(label)
        && /notification/i.test(label)
      );
      const isTurnOn = (
        isExactTurnOn
        || isNotificationTurnOn
        || /turn on desktop notifications/i.test(label)
        || /enable (desktop )?notifications/i.test(label)
        || /aktifkan notifikasi/i.test(label)
        || /nyalakan notifikasi/i.test(label)
      );
      if (!isTurnOn) continue;

      // Never click dismiss-style controls.
      if (/\b(close|not now|dismiss|maybe later|nanti|tutup)\b/i.test(label) && !isExactTurnOn) continue;

      result.candidates.push(label.slice(0, 100));
      try {
        el.scrollIntoView?.({ block: 'center', inline: 'center' });
        el.focus?.();
        el.click();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        result.clicked.push({
          action: 'turn-on',
          label: label.slice(0, 100),
          text: text.slice(0, 80),
          testId: el.getAttribute('data-testid') || null,
        });
      } catch (error) {
        result.clicked.push({ action: 'turn-on', error: error.message, label: label.slice(0, 100) });
      }
    }
    return result;
  });
}

async function captureCallDebugScreenshot(tag = 'call') {
  try {
    const file = path.join(paths.state, `debug-${tag}-${Date.now()}.png`);
    await client.pupPage.screenshot({ path: file, fullPage: false });
    return file;
  } catch (error) {
    return `screenshot-failed: ${error.message}`;
  }
}

async function dumpCallUiSnapshot() {
  return await client.pupPage.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], div[role="button"], span[data-icon], [data-testid]'));
    const buttons = nodes.map((el) => {
      const rect = el.getBoundingClientRect?.() || { x: 0, y: 0, width: 0, height: 0 };
      return {
        tag: el.tagName,
        ariaLabel: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        dataTestId: el.getAttribute('data-testid') || '',
        dataIcon: el.getAttribute('data-icon') || el.querySelector?.('[data-icon]')?.getAttribute('data-icon') || '',
        text: (el.innerText || el.textContent || '').trim().slice(0, 80),
        visible: rect.width > 0 && rect.height > 0,
        x: Math.round(rect.x || 0),
        y: Math.round(rect.y || 0),
      };
    }).filter((b) => b.visible).slice(0, 120);

    let callState = null;
    try {
      const CC = window.require('WAWebCallCollection');
      const active = CC?.lastActiveCall || null;
      const mapKey = Object.keys(CC || {}).find((k) => CC[k] instanceof Map);
      const mapSize = mapKey ? CC[mapKey].size : null;
      callState = {
        isInConnectedCall: Boolean(CC?.isInConnectedCall),
        pendingOfferCount: CC?.pendingOffers ? Object.keys(CC.pendingOffers).length : 0,
        mapSize,
        lastActiveCall: active ? {
          id: active.id,
          peerJid: active.peerJid,
          state: active.state,
          canHandleLocally: active.canHandleLocally,
          webClientShouldHandle: active.webClientShouldHandle,
        } : null,
      };
    } catch (error) {
      callState = { error: error.message };
    }

    // Also capture any visible text that looks like an incoming call toast/banner.
    const bodyText = (document.body?.innerText || '').slice(0, 1500);
    return { buttons, callState, href: location.href, bodyTextSnippet: bodyText };
  });
}

async function getCallConnectionState() {
  return await client.pupPage.evaluate(() => {
    try {
      const CC = window.require('WAWebCallCollection');
      const active = CC?.activeCall || CC?.lastActiveCall || null;
      const state = active
        ? (typeof active.getState === 'function' ? active.getState() : (active.state ?? null))
        : null;
      return {
        isInConnectedCall: Boolean(CC?.isInConnectedCall),
        pendingOfferCount: CC?.pendingOffers ? Object.keys(CC.pendingOffers).length : 0,
        lastActiveCallId: active?.id || null,
        lastActiveCallState: state,
        peerJid: active?.peerJid?._serialized || active?.peerJid || null,
      };
    } catch (error) {
      return { error: error.message, isInConnectedCall: false };
    }
  });
}

async function clickMatchingButtons(matchers, { maxClicks = 2, exclude = [] } = {}) {
  return await client.pupPage.evaluate((patterns, limit, excludePatterns) => {
    const regexes = patterns.map((p) => new RegExp(p, 'i'));
    const excludeRes = excludePatterns.map((p) => new RegExp(p, 'i'));
    const selectors = [
      'button',
      '[role="button"]',
      'div[role="button"]',
      '[data-testid]',
      'span[data-icon]',
      'div[aria-label]',
    ].join(',');
    const candidates = Array.from(document.querySelectorAll(selectors));
    const clicked = [];
    const scanned = [];

    for (const el of candidates) {
      const rect = el.getBoundingClientRect?.() || { width: 0, height: 0 };
      if (!(rect.width > 0 && rect.height > 0)) continue;

      const label = [
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        el.getAttribute('data-testid') || '',
        el.getAttribute('data-icon') || '',
        el.querySelector?.('[data-icon]')?.getAttribute('data-icon') || '',
        el.innerText || '',
        el.textContent || '',
      ].join(' ').replace(/\s+/g, ' ').trim();

      if (!label) continue;
      if (excludeRes.some((re) => re.test(label))) continue;
      if (!regexes.some((re) => re.test(label))) continue;

      scanned.push(label.slice(0, 120));
      if (clicked.length >= limit) continue;
      try {
        el.scrollIntoView?.({ block: 'center', inline: 'center' });
        el.click();
        // Also dispatch pointer events for React handlers that ignore plain click.
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        clicked.push({
          label: label.slice(0, 120),
          dataTestId: el.getAttribute('data-testid') || null,
          dataIcon: el.getAttribute('data-icon') || el.querySelector?.('[data-icon]')?.getAttribute('data-icon') || null,
        });
      } catch (error) {
        clicked.push({ label: label.slice(0, 120), error: error.message });
      }
    }
    return { clicked, scanned: scanned.slice(0, 20), candidateCount: candidates.length };
  }, matchers, maxClicks, exclude);
}

async function rejectActiveCall(callInfo = lastCall) {
  if (!callInfo) return { success: false, error: 'No active call to reject.' };
  // Prefer VoIP stack reject (PR #201825) over library WAWap reject stanza.
  try {
    const voip = await voipRejectCall(client.pupPage, { callId: callInfo?.id || lastCall?.id || null });
    if (voip?.success) {
      log.info('call-rejected', { id: callInfo.id, from: callInfo.from, method: 'voip-stack', voip });
      return { success: true, method: 'voip-stack', voip, rejectedCall: lastCall };
    }
  } catch (error) {
    log.debug('call-reject-voip-failed', error.message);
  }
  try {
    if (typeof callInfo.reject === 'function') {
      await callInfo.reject();
      log.info('call-rejected', { id: callInfo.id, from: callInfo.from, method: 'library' });
      return { success: true, method: 'library', rejectedCall: lastCall };
    }
  } catch (error) {
    log.debug('call-reject-library-failed', error.message);
  }

  const ui = await clickMatchingButtons(['decline', 'reject', 'tolak', 'end call', 'akhiri'], { maxClicks: 2 });
  log.info('call-rejected', { id: callInfo.id, from: callInfo.from, method: 'ui', ui });
  return { success: ui.clicked.length > 0, method: 'ui', ui, rejectedCall: lastCall };
}

async function hangupActiveCall() {
  // Prefer VoIP stack endCall first (PR #201825 / #201881). UI click is fallback only —
  // broad matchers like "end" previously false-matched chat-list / wordmark nodes.
  let internal = [];
  try {
    const voip = await voipEndCall(client.pupPage, { callId: lastCall?.id || activeBotCall?.id || null });
    internal.push(voip);
  } catch (error) {
    internal.push({ method: 'voipEndCall', success: false, error: error.message });
  }

  let ui = { clicked: [], scanned: [], candidateCount: 0 };
  const voipOk = internal.some((item) => item && item.success);
  if (!voipOk) {
    ui = await clickMatchingButtons([
      '^end call$',
      '^hang up$',
      'akhiri panggilan',
      'end-call',
      'ic-call-end',
      'ic-call-end-filled',
      'wds-ic-call-end',
    ], { maxClicks: 1, exclude: ['send', 'document', 'notification', 'chat', 'list', 'wordmark', 'status'] });
  }

  const success = voipOk || ui.clicked.length > 0;
  if (activeBotCall) {
    activeBotCall = {
      ...activeBotCall,
      status: success ? 'hung-up' : 'hangup-failed',
      hungUpAt: new Date().toISOString(),
      hangup: { ui, internal },
    };
  }
  logJson('info', 'call-hangup', { success, ui, internal, reason: voipOk ? 'voip-first' : 'ui-fallback' });
  return { success, ui, internal };
}

async function tryInternalAccept(callInfo, { injectAudio = botAudioInject } = {}) {
  // Port of wwebjs PR #201825 acceptCall via VoIP stack (see lib/call-bridge.mjs).
  // Also tries alternate module names from PR #201881-style controller resolution.
  // Never sends raw WAWap accept stanzas (dismiss ring / no media).
  try {
    const result = await voipAcceptCall(client.pupPage, {
      callId: callInfo.id,
      isVideo: Boolean(callInfo.isVideo),
      injectAudio: Boolean(injectAudio),
    });
    return Array.isArray(result) ? result : [result];
  } catch (error) {
    return [{ method: 'voipAcceptCall', success: false, error: error.message }];
  }
}

async function waitForConnectedCall({ timeoutMs = 8000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await getCallConnectionState();
    if (last?.isInConnectedCall) return { connected: true, state: last };
    // State names vary; treat common connected labels as success.
    if (typeof last?.lastActiveCallState === 'string'
      && /connected|active|ongoing|in_call|accepted|call_active|received_call|accept/i.test(last.lastActiveCallState)) {
      return { connected: true, state: last };
    }
    // Numeric WA call states: non-zero / progressive states often mean in-call.
    if (typeof last?.lastActiveCallState === 'number' && last.lastActiveCallState > 0) {
      // Prefer isInConnectedCall, but accept mid-call numeric progress after accept.
      if (last.lastActiveCallState >= 3) return { connected: true, state: last };
    }
    // Bridge connection helper may expose richer flags.
    try {
      const bridgeState = await client.pupPage.evaluate(() => window.__whatsealCallBridgeApi?.connectionState?.() || null);
      if (bridgeState?.isInConnectedCall) return { connected: true, state: { ...last, bridgeState } };
    } catch { /* ignore */ }
    await sleep(400);
  }
  return { connected: false, state: last };
}

async function acceptIncomingCall(callInfo, {
  hangupAfterAudio = botHangupAfterAudio,
  injectAudio = botAudioInject,
} = {}) {
  if (!callInfo) return { success: false, error: 'No active call to accept.' };
  if (botCallInFlight) return { success: false, error: 'Another bot call is already in progress.', activeBotCall };

  botCallInFlight = true;
  const startedAt = new Date().toISOString();
  const shouldInject = Boolean(injectAudio);
  const shouldHangupAfter = Boolean(hangupAfterAudio) && shouldInject;
  activeBotCall = {
    id: callInfo.id,
    from: callInfo.from,
    isVideo: Boolean(callInfo.isVideo),
    isGroup: Boolean(callInfo.isGroup),
    canHandleLocally: callInfo.canHandleLocally,
    webClientShouldHandle: callInfo.webClientShouldHandle,
    status: 'accepting',
    botAudioPath,
    injectAudio: shouldInject,
    hangupAfterAudio: shouldHangupAfter,
    startedAt,
    headless: voiceBotHeadless,
  };

  try {
    // STRICT USER RULES:
    // - Do not dismiss / hide the incoming-call UI
    // - Do not body-click, open settings, type secrets, or send signal-only stanzas
    // - Prefer: click Accept only. Fallback: VoIP stack acceptCall (PR #201825 / #201881 port)
    await focusWhatsAppWindow({ clickBody: false });
    try {
      await installCallBridge(client.pupPage);
      await patchIncomingCallListener(client.pupPage);
    } catch (bridgeError) {
      logJson('error', 'call-bridge-ensure-failed', { error: bridgeError.message });
    }
    await sleep(600);

    const beforeUi = await dumpCallUiSnapshot();
    const beforeShot = await captureCallDebugScreenshot('before-accept');
    logJson('info', 'call-ui-before-accept', {
      callId: callInfo.id,
      canHandleLocally: callInfo.canHandleLocally,
      webClientShouldHandle: callInfo.webClientShouldHandle,
      callState: beforeUi.callState,
      interestingButtons: (beforeUi.buttons || []).filter((b) => /accept|decline|answer|reject|call|phone|tolak|terima/i.test(`${b.ariaLabel} ${b.text} ${b.dataTestId} ${b.dataIcon}`)),
      buttonCount: (beforeUi.buttons || []).length,
      screenshot: beforeShot,
    });

    const acceptMatchers = [
      '^accept$',
      '^answer$',
      'accept call',
      'answer call',
      '^terima$',
      '^angkat$',
      'voice call accept',
      'video call accept',
      'call-accept',
      'accept-call',
      'answer-call',
      'phone-accept',
      'ic-accept',
      'accept-phone',
      'wds-ic-phone-accept',
      'wds-ic-videocall-accept',
      'call-incoming-accept',
    ];
    const excludeMatchers = [
      'decline',
      'reject',
      'tolak',
      'end call',
      'hang up',
      'akhiri',
      'cancel',
      'close',
      'turn on',
      'notification',
      'mute',
      'missed',
      'callback',
    ];

    let acceptUi = { clicked: [], scanned: [], candidateCount: 0 };
    let connected = { connected: false, state: null };
    let internal = [];

    // Prefer VoIP accept immediately. Meta often disables web calling AB prop so
    // the Accept UI never mounts; waiting 12s first makes the offer go stale.
    // Never raw WAWap accept stanzas.
    internal = await tryInternalAccept(callInfo, { injectAudio: shouldInject });
    logJson('info', 'call-accept-voip-stack', {
      internal,
      reason: 'voip-first',
      injectAudio: shouldInject,
    });
    const voipOk = internal.some((item) => item && item.success);
    connected = await waitForConnectedCall({ timeoutMs: voipOk ? 15000 : 4000 });

    // If VoIP did not connect, briefly poll for Accept UI (popup-safe, Accept-only).
    if (!connected.connected) {
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        acceptUi = await clickMatchingButtons(acceptMatchers, {
          maxClicks: 1,
          exclude: excludeMatchers,
        });
        logJson('info', 'call-accept-click-attempt', {
          attempt,
          clicked: acceptUi.clicked,
          scanned: acceptUi.scanned,
          candidateCount: acceptUi.candidateCount,
        });
        if (acceptUi.clicked.length > 0) {
          connected = await waitForConnectedCall({ timeoutMs: 8000 });
          if (connected.connected) break;
        }
        // One more VoIP attempt mid-ring if UI still missing.
        if (attempt === 3 && !voipOk) {
          internal = await tryInternalAccept(callInfo, { injectAudio: shouldInject });
          logJson('info', 'call-accept-voip-stack', {
            internal,
            reason: 'voip-retry-mid-ui',
            injectAudio: shouldInject,
          });
          connected = await waitForConnectedCall({ timeoutMs: 10000 });
          if (connected.connected) break;
        }
        await sleep(500);
      }
    }

    const afterUi = await dumpCallUiSnapshot();
    const afterShot = await captureCallDebugScreenshot(connected.connected ? 'accepted' : 'accept-failed');
    const accepted = Boolean(connected.connected);
    activeBotCall = {
      ...activeBotCall,
      status: accepted ? 'accepted' : 'accept-failed',
      acceptedAt: new Date().toISOString(),
      accept: {
        ui: acceptUi,
        internal,
        connected,
        screenshots: { before: beforeShot, after: afterShot },
        beforeUi: {
          callState: beforeUi.callState,
          interestingButtons: (beforeUi.buttons || []).filter((b) => /accept|decline|answer|reject|call|phone|tolak|terima/i.test(`${b.ariaLabel} ${b.text} ${b.dataTestId} ${b.dataIcon}`)),
        },
        afterUi: {
          callState: afterUi.callState,
          interestingButtons: (afterUi.buttons || []).filter((b) => /accept|decline|answer|reject|call|phone|tolak|terima/i.test(`${b.ariaLabel} ${b.text} ${b.dataTestId} ${b.dataIcon}`)),
        },
      },
    };
    logJson('info', 'call-accept-attempt', activeBotCall);

    if (!accepted) {
      return {
        success: false,
        error: 'Accept UI not clicked / not connected. No UI-dismiss actions were used. Official wwebjs has reject-only; experimental path is voip-stack acceptCall (PR #201825).',
        call: activeBotCall,
      };
    }

    if (shouldHangupAfter) {
      const audioMs = await getWavDurationMs(botAudioPath);
      activeBotCall = { ...activeBotCall, status: 'playing-bot-audio', audioMs, botAudioPath };
      logJson('info', 'call-bot-audio-start', { audioMs, botAudioPath, injectAudio: shouldInject });

      // Critical: Chrome fake-mic flag alone is not enough once we patch getUserMedia
      // to a WebAudio destination (PR #201825 inject). Without feeding that graph,
      // the peer hears silence. Decode the greeting WAV and play into the mic stream.
      let playback = null;
      try {
        const wavBuf = await readFile(botAudioPath);
        const base64 = wavBuf.toString('base64');
        playback = await playBotAudioBase64(client.pupPage, base64);
        logJson('info', 'call-bot-audio-played', { playback, botAudioPath, bytes: wavBuf.length });
      } catch (error) {
        playback = { success: false, error: error.message };
        logJson('error', 'call-bot-audio-play-failed', { error: error.message, botAudioPath });
      }

      const playedMs = Number(playback?.durationMs || playback?.durationSec * 1000 || 0);
      const waitMs = (playback?.success && playedMs > 0)
        ? playedMs + botHangupPaddingMs
        : audioMs + botHangupPaddingMs;
      if (!(playback?.success && playedMs > 0)) {
        await sleep(waitMs);
      } else if (botHangupPaddingMs > 0) {
        await sleep(botHangupPaddingMs);
      }

      const hangup = await hangupActiveCall();
      activeBotCall = {
        ...activeBotCall,
        status: hangup.success ? 'completed' : 'hangup-failed',
        completedAt: new Date().toISOString(),
        waitMs,
        playback,
        hangup,
      };
      logJson('info', 'call-bot-complete', activeBotCall);
    } else {
      activeBotCall = {
        ...activeBotCall,
        status: 'accepted',
        completedAt: new Date().toISOString(),
        note: shouldInject
          ? 'Accepted with inject enabled but hangup-after-audio disabled; call left open.'
          : 'Accepted without bot audio inject; call left open.',
      };
      logJson('info', 'call-accept-open', activeBotCall);
    }

    return {
      success: true,
      call: activeBotCall,
      botAudioPath,
      injectAudio: shouldInject,
      hangupAfterAudio: shouldHangupAfter,
      note: shouldInject
        ? 'Bot audio: WebAudio → patched getUserMedia destination (bridge v6+). VoIP-first accept.'
        : 'Accepted without audio inject (WHATSAPP_BOT_AUDIO_INJECT=0 or injectAudio:false).',
    };
  } catch (error) {
    activeBotCall = {
      ...(activeBotCall || {}),
      status: 'error',
      error: error.message,
      failedAt: new Date().toISOString(),
    };
    logJson('error', 'call-accept-failed', { error: error.message, call: activeBotCall });
    return { success: false, error: error.message, call: activeBotCall };
  } finally {
    botCallInFlight = false;
  }
}

client.on('call', async (call) => {
  // Ignore duplicate/stale call events while a bot flow is already running.
  if (botCallInFlight && lastCall?.id === call.id) {
    logJson('info', 'incoming-call-duplicate-ignored', { id: call.id, from: call.from });
    return;
  }

  lastCall = {
    id: call.id,
    from: call.from,
    isVideo: call.isVideo,
    isGroup: call.isGroup,
    canHandleLocally: call.canHandleLocally,
    webClientShouldHandle: call.webClientShouldHandle,
    timestamp: new Date().toISOString(),
    // Keep library reject helper for later use.
    reject: typeof call.reject === 'function' ? call.reject.bind(call) : null,
  };
  logJson('info', 'incoming-call', {
    id: lastCall.id,
    from: lastCall.from,
    isVideo: lastCall.isVideo,
    isGroup: lastCall.isGroup,
    canHandleLocally: lastCall.canHandleLocally,
    webClientShouldHandle: lastCall.webClientShouldHandle,
    autoAcceptCalls,
    headless: voiceBotHeadless,
  });

  if (!autoAcceptCalls) return;
  if (call.fromMe) return;
  // Fire-and-forget so the event handler doesn't block other call updates.
  // inject/hangup follow WHATSAPP_BOT_AUDIO_INJECT + WHATSAPP_BOT_HANGUP_AFTER_AUDIO.
  void acceptIncomingCall(lastCall, {
    hangupAfterAudio: botHangupAfterAudio,
    injectAudio: botAudioInject,
  });
});

async function socketIsActive() {
  try {
    const stat = await lstat(paths.socket);
    if (!stat.isSocket()) throw new Error(`Refusing to replace non-socket path: ${paths.socket}`);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  return await new Promise((resolve) => {
    const probe = net.createConnection(paths.socket);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  log.info('shutdown-start', `signal=${signal}`);
  phase = 'stopping';
  await publishState().catch(() => {});
  for (const socket of activeSockets) socket.destroy();
  await Promise.race([
    new Promise((resolve) => server?.close(resolve) || resolve()),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  await Promise.race([
    new Promise((resolve) => httpServer?.close(resolve) || resolve()),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  await client.destroy().catch(() => {});
  await rm(paths.socket, { force: true });
  await removeQr();
  log.info('shutdown-complete', `signal=${signal}`);
  process.exit(exitCode);
}

async function main() {
  log.info('start', `chrome=${chromePath}`);
  logJson('info', 'voice-bot-config', {
    autoAcceptCalls,
    botAudioInject,
    botHangupAfterAudio,
    botAudioPath,
    botHangupPaddingMs,
    headless: voiceBotHeadless,
  });
  if (botAudioInject) {
    try {
      await lstat(botAudioPath);
    } catch (error) {
      log.error('voice-bot-audio-missing', `${botAudioPath}: ${error.message}`);
    }
  }
  await ensurePrivateDirectories();
  await removeQr();
  const persistedLedger = await readJson(paths.sendLedger, { outcomes: [] });
  for (const outcome of persistedLedger.outcomes || []) {
    if (!outcome?.approvalId) continue;
    if (outcome.state === 'sending' || outcome.state === 'awaiting-local-approval') {
      outcome.state = 'outcome-unknown';
      outcome.detail = 'Backend restarted before the previous operation reached a definitive outcome.';
      outcome.updatedAt = new Date().toISOString();
    }
    const sanitized = { ...outcome };
    if (outcome.message) {
      sanitized.message = {
        id: String(outcome.message.id || ''),
        timestamp: Number(outcome.message.timestamp || 0),
        ack: Number(outcome.message.ack ?? 0),
        ackLabel: String(outcome.message.ackLabel || ackLabel(Number(outcome.message.ack ?? 0))),
        type: String(outcome.message.type || 'unknown'),
        hasMedia: Boolean(outcome.message.hasMedia),
        acknowledgementHistory: Array.isArray(outcome.message.acknowledgementHistory)
          ? outcome.message.acknowledgementHistory.slice(-10)
          : [],
      };
    }
    sendOutcomes.set(outcome.approvalId, sanitized);
  }
  if (sendOutcomes.size > 0) {
    await writeJsonAtomic(paths.sendLedger, { version: 1, outcomes: [...sendOutcomes.values()].slice(-200) });
  }
  if (await socketIsActive()) throw new Error(`Another WhatsApp backend is already listening at ${paths.socket}`);
  await rm(paths.socket, { force: true });

  server = net.createServer((socket) => void handleConnection(socket));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, resolve);
  });
  await chmod(paths.socket, 0o600);
  await publishState();
  log.info('control-socket-ready', `path=${paths.socket}`);

  // Start HTTP API server for Web UI (no fingerprint required)
  const app = express();
  app.use(express.json());
  
  // CORS for local dev
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // GET /api/status
  app.get('/api/status', async (req, res) => {
    try {
      res.json({ ok: true, result: { phase, ready: phase === 'ready', connectionState } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/me - get current WhatsApp user info
  app.get('/api/me', async (req, res) => {
    try {
      if (phase !== 'ready') return res.status(503).json({ error: 'WhatsApp not ready' });
      const info = client.info;
      res.json({
        ok: true,
        result: {
          wid: info?.wid?._serialized || null,
          pushname: info?.pushname || null,
          phone: info?.wid?.user || null,
          platform: info?.platform || null
        }
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/qr - get QR code for pairing
  app.get('/api/qr', async (req, res) => {
    try {
      if (phase === 'ready') {
        return res.json({ ok: true, result: null, message: 'Already authenticated' });
      }
      // Check if QR file exists
      const qrExists = await readFile(paths.qrFile).then(() => true).catch(() => false);
      if (!qrExists) {
        return res.json({ ok: true, result: null, message: 'QR not available yet' });
      }
      res.json({
        ok: true,
        result: {
          available: true,
          imageUrl: '/api/qr/image'
        }
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/qr/image - serve QR code image
  app.get('/api/qr/image', async (req, res) => {
    try {
      const qrData = await readFile(paths.qrFile);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(qrData);
    } catch (err) {
      res.status(404).json({ ok: false, error: 'QR code not available' });
    }
  });

  // GET /api/chats
  app.get('/api/chats', async (req, res) => {
    try {
      if (phase !== 'ready') return res.status(503).json({ error: 'WhatsApp not ready' });
      const chats = await getChatSummaries({ includeLastMessage: true });
      const transformed = chats.map(chat => ({
        id: chat.id,
        name: chat.name || chat.id,
        profile_picture: null,
        unread: chat.unreadCount || 0,
        lastMessage: chat.lastMessage?.body || '',
        timestamp: chat.timestamp || Date.now(),
        typing: false,
        isGroup: chat.isGroup,
        messages: { TODAY: [] }
      }));
      res.json(transformed);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/messages/:chatId
  app.get('/api/messages/:chatId', async (req, res) => {
    try {
      if (phase !== 'ready') return res.status(503).json({ error: 'WhatsApp not ready' });
      const { chatId } = req.params;
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const messages = await getMessagesDirect(chatId, limit);
      const transformed = messages.map(msg => ({
        content: msg.body,
        sender: msg.fromMe ? null : chatId,
        time: new Date(msg.timestamp * 1000).toLocaleTimeString(),
        timestamp: msg.timestamp,
        status: msg.ack >= 2 ? 'read' : msg.ack === 1 ? 'delivered' : 'sent',
        id: msg.id,
        type: msg.type,
        hasMedia: msg.hasMedia || false,
        mediaUrl: msg.hasMedia ? `/api/media/${encodeURIComponent(msg.id)}` : null
      }));
      res.json(transformed);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/media/:messageId - serve media (stickers, images, etc)
  app.get('/api/media/:messageId', async (req, res) => {
    try {
      if (phase !== 'ready') return res.status(503).json({ error: 'WhatsApp not ready' });
      const { messageId } = req.params;
      const decodedId = decodeURIComponent(messageId);
      log.info('media-request', `messageId=${decodedId}`);
      
      // Extract chatId from messageId (format: true/false_chatId_msgId)
      const parts = decodedId.split('_');
      if (parts.length < 2) {
        return res.status(400).json({ error: 'Invalid message ID format' });
      }
      const chatId = parts[1];
      
      // Download media directly via puppeteer using WWebJS pattern
      const mediaData = await client.pupPage.evaluate(async (targetChatId, targetMsgId) => {
        try {
          const chat = await window.WWebJS.getChat(targetChatId, { getAsModel: false });
          if (!chat) return { error: 'Chat not found' };
          
          const messages = chat.msgs?.getModelsArray?.() || [];
          const serialized = (v) => v?._serialized ?? v?.$1 ?? String(v || '');
          const msg = messages.find(m => serialized(m.id) === targetMsgId);
          
          if (!msg) return { error: 'Message not found' };
          
          const isMedia = Boolean(msg.mediaData || msg.isMedia) || 
                          ['image', 'video', 'audio', 'ptt', 'sticker', 'document'].includes(msg.type);
          if (!isMedia) return { error: 'Message has no media' };
          
          // Helper to convert ArrayBuffer to base64
          const arrayBufferToBase64 = (buffer) => {
            const arr = new Uint8Array(buffer);
            let b64 = '';
            const chunk = 8192;
            for (let i = 0; i < arr.length; i += chunk) {
              b64 += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
            }
            return btoa(b64);
          };
          
          // Try using MsgInfoStore/MsgStore to download
          if (window.Store?.MsgLoad?.downloadMedia) {
            try {
              await window.Store.MsgLoad.downloadMedia(msg);
              if (msg.mediaData?.mediaBlob) {
                const blob = msg.mediaData.mediaBlob;
                return { ok: true, mimetype: msg.mimetype || 'image/webp', data: arrayBufferToBase64(await blob.arrayBuffer()) };
              }
            } catch(e) { /* continue */ }
          }
          
          // Try direct download using decryptAndDownload
          if (msg.mediaData && typeof msg.mediaData.decryptAndDownload === 'function') {
            try {
              await msg.mediaData.decryptAndDownload();
              if (msg.mediaData.mediaBlob) {
                const blob = msg.mediaData.mediaBlob;
                return { ok: true, mimetype: msg.mimetype || 'image/webp', data: arrayBufferToBase64(await blob.arrayBuffer()) };
              }
            } catch(e) { /* continue */ }
          }

          // Try using DownloadManager
          if (window.Store?.DownloadManager?.downloadAndDecrypt) {
            try {
              const result = await window.Store.DownloadManager.downloadAndDecrypt({
                directPath: msg.directPath,
                encFilehash: msg.encFilehash,
                filehash: msg.filehash,
                mediaKey: msg.mediaKey,
                mediaKeyTimestamp: msg.mediaKeyTimestamp,
                type: msg.type,
                signal: (new AbortController()).signal
              });
              if (result) {
                return { ok: true, mimetype: msg.mimetype || 'image/webp', data: arrayBufferToBase64(result) };
              }
            } catch(e) { /* continue */ }
          }
          
          // Try simple fetch from deprecatedMms3Url 
          const mediaUrl = msg.deprecatedMms3Url || msg.clientUrl;
          if (mediaUrl) {
            try {
              const response = await fetch(mediaUrl);
              if (response.ok) {
                const blob = await response.blob();
                return { ok: true, mimetype: msg.mimetype || blob.type || 'image/webp', data: arrayBufferToBase64(await blob.arrayBuffer()) };
              }
            } catch(e) { /* continue */ }
          }
          
          return { error: 'Could not download media - all methods failed' };
        } catch (e) {
          return { error: e.message || String(e) };
        }
      }, chatId, decodedId);
      
      if (mediaData.error) {
        log.error('media-download-error', mediaData.error);
        return res.status(404).json({ error: mediaData.error });
      }
      
      log.info('media-download-complete', `mimetype=${mediaData.mimetype} dataLen=${mediaData.data?.length}`);
      
      const buffer = Buffer.from(mediaData.data, 'base64');
      res.setHeader('Content-Type', mediaData.mimetype);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buffer);
    } catch (err) {
      log.error('media-download-error', `${err.message} stack=${err.stack?.split('\n')[1]}`);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/send - Direct send without fingerprint (Web UI only)
  app.post('/api/send', async (req, res) => {
    try {
      if (phase !== 'ready') return res.status(503).json({ error: 'WhatsApp not ready' });
      const { chatId, text } = req.body;
      if (!chatId || !text) return res.status(400).json({ error: 'chatId and text required' });
      
      assertSendRateLimit();
      const chat = await resolveChat(chatId);
      const sent = await client.sendMessage(chat.id, text, {
        sendSeen: false,
        waitUntilMsgSent: true,
      });
      await client.sendPresenceUnavailable().catch(() => {});
      
      res.json({
        success: true,
        message: sent ? {
          id: sent.id?._serialized || '',
          timestamp: Number(sent.timestamp || 0),
          ack: Number(sent.ack ?? 0),
        } : null
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Multi-account: each daemon binds its own localhost HTTP port from the account id.
  const HTTP_PORT = resolveHttpPort(accountId);
  httpServer = http.createServer(app);
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(HTTP_PORT, '127.0.0.1', resolve);
  });
  log.info('http-api-ready', `account=${accountId || 'default'} port=${HTTP_PORT} url=http://localhost:${HTTP_PORT}`);

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    log.error('uncaught-exception', error.stack || error.message);
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (error) => {
    log.error('unhandled-rejection', error?.stack || error?.message || String(error));
    void shutdown('unhandledRejection', 1);
  });

  log.info('browser-initialize', 'starting isolated headless Chrome');
  let heartbeat = 0;
  const heartbeatTimer = setInterval(() => {
    heartbeat += 1;
    log.info('browser-initialize-progress', `elapsed=${heartbeat}s phase=${phase}`);
  }, 1000);
  try {
    await Promise.race([
      client.initialize(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('WhatsApp initialization exceeded 180 seconds.')), 180000)),
    ]);
  } finally {
    clearInterval(heartbeatTimer);
  }
}

main().catch(async (error) => {
  log.error('fatal', error.stack || error.message);
  phase = 'failed';
  qrGeneration += 1;
  await publishState({ error: truncateText(error.message, 300) }).catch(() => {});
  await shutdown('fatal', 1);
});