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
import process from 'node:process';
import QRCode from 'qrcode';
import whatsapp from 'whatsapp-web.js';

import {
  createLogger,
  DraftStore,
  ensurePrivateDirectories,
  parseCommonArgs,
  paths,
  readJson,
  truncateText,
  writeFileAtomic,
  writeJsonAtomic,
} from './lib/core.mjs';

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

if (help) {
  process.stdout.write('Usage: node daemon.mjs [--verbose|-v]\n\nRuns the private local WhatsApp Web backend.\n\nEnvironment:\n  WHATSAPP_POLICY_MODE  balanced | developer (default: balanced)\n');
  process.exit(0);
}

const POLICY_MODE = (['balanced', 'developer'].includes(process.env.WHATSAPP_POLICY_MODE)
  ? process.env.WHATSAPP_POLICY_MODE
  : 'balanced');

let phase = 'starting';
let connectionState = null;
let qrUpdatedAt = null;
let readyAt = null;
let shuttingDown = false;
let server;
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
    headless: true,
    executablePath: chromePath,
    pipe: true,
    args: [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-features=Translate,MediaRouter',
      '--no-first-run',
      '--no-default-browser-check',
    ],
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
      policyMode: POLICY_MODE,
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

// Fields that represent critical integrity (dependency/helper compromise).
const CRITICAL_DRIFT_FIELDS = new Set([
  'installedDependenciesStartupSha256',
  'messageApprovalHelperSha256',
  'baselineApprovalHelperSha256',
  'packageLockSha256',
  'whatsappWebJsIntegrity',
]);

// Fields that represent local source changes during development.
const SOURCE_DRIFT_FIELDS = new Set([
  'backendStartupSourceSha256',
  'backendCurrentDiskSourceSha256',
  'backendSourceMatchesStartup',
]);

// Fields that represent upstream runtime updates (WhatsApp Web, Chrome, Node).
const RUNTIME_DRIFT_FIELDS = new Set([
  'whatsappWebVersion',
  'browserVersion',
  'nodeVersion',
  'platform',
]);

// Missing baseline is a setup-phase field, not a security compromise.
const SETUP_DRIFT_FIELDS = new Set(['baseline']);

function classifyDrift(drift) {
  const critical = drift.filter((d) => CRITICAL_DRIFT_FIELDS.has(d.field));
  const source = drift.filter((d) => SOURCE_DRIFT_FIELDS.has(d.field));
  const runtime = drift.filter((d) => RUNTIME_DRIFT_FIELDS.has(d.field));
  const setup = drift.filter((d) => SETUP_DRIFT_FIELDS.has(d.field));
  const other = drift.filter((d) => !CRITICAL_DRIFT_FIELDS.has(d.field) && !SOURCE_DRIFT_FIELDS.has(d.field) && !RUNTIME_DRIFT_FIELDS.has(d.field) && !SETUP_DRIFT_FIELDS.has(d.field));
  return { critical, source, runtime, setup, other };
}

async function assertSendCompatibility() {
  const report = await getCompatibilityReport();
  if (report.approval.approvedForSending) return;

  const { critical, source, runtime, setup, other } = classifyDrift(report.approval.drift);

  // Critical drift always blocks sending regardless of mode.
  if (critical.length > 0) {
    const fields = critical.map((d) => d.field).join(', ');
    throw new Error(`Sending is blocked by critical integrity drift: ${fields}. Dependency or helper compromise detected.`);
  }

  if (POLICY_MODE === 'developer') {
    // Developer mode: source, runtime, and setup (missing baseline) drift are tolerated for send.
    if (other.length > 0) {
      const fields = other.map((d) => d.field).join(', ');
      throw new Error(`Sending is blocked by unclassified drift: ${fields}. Promote a new baseline.`);
    }
    if (source.length > 0 || runtime.length > 0 || setup.length > 0) {
      log.debug('policy-developer-send', `tolerating drift: ${[...source, ...runtime, ...setup].map((d) => d.field).join(', ')}`);
    }
    return;
  }

  // Balanced mode: runtime drift alone is tolerated for send; source and setup drift block.
  if (source.length > 0 || other.length > 0 || setup.length > 0) {
    const fields = [...source, ...other, ...setup].map((d) => d.field).join(', ');
    throw new Error(`Sending is blocked by source drift: ${fields}. Promote a new baseline.`);
  }
  if (runtime.length > 0) {
    log.debug('policy-balanced-send', `tolerating runtime drift: ${runtime.map((d) => d.field).join(', ')}`);
  }
}

async function assertContentCompatibility() {
  const report = await getCompatibilityReport();
  if (report.approval.approvedForSending) return;

  const { critical, source, runtime, setup, other } = classifyDrift(report.approval.drift);

  // Critical drift always blocks content regardless of mode.
  if (critical.length > 0) {
    const fields = critical.map((d) => d.field).join(', ');
    throw new Error(`Chat content access is blocked by critical integrity drift: ${fields}. Dependency or helper compromise detected.`);
  }

  // Developer: source, runtime, and setup drift never block reading.
  if (POLICY_MODE === 'developer') {
    if (other.length > 0) {
      const fields = other.map((d) => d.field).join(', ');
      throw new Error(`Chat content access is blocked by unclassified drift: ${fields}. Promote a new baseline.`);
    }
    return;
  }

  // Balanced: source and setup drift block content, runtime drift does not.
  if (source.length > 0 || other.length > 0 || setup.length > 0) {
    const fields = [...source, ...other, ...setup].map((d) => d.field).join(', ');
    throw new Error(`Chat content access is blocked by source drift: ${fields}. Promote a new baseline.`);
  }
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
      policyMode: POLICY_MODE,
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

  await ensureReady();

  if (method === 'listChats') {
    await assertContentCompatibility();
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
    await assertContentCompatibility();
    const chat = await resolveChat(params.chat);
    const limit = Math.min(Math.max(Number(params.limit || 30), 1), 200);
    const messages = await getMessagesDirect(chat.id, limit);
    return {
      chat: { id: chat.id, name: chat.name || '', isGroup: Boolean(chat.isGroup) },
      messages,
    };
  }

  if (method === 'searchMessages') {
    await assertContentCompatibility();
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
    await assertContentCompatibility();
    const messageId = String(params.messageId || '').trim();
    if (!messageId) throw new Error('A message ID is required.');
    return await getMessageStatusDirect(messageId);
  }

  if (method === 'prepareSend') {
    await assertSendCompatibility();
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
    await assertSendCompatibility();
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
    await assertSendCompatibility();
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
    await assertSendCompatibility();
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
      await assertSendCompatibility();
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
      await assertSendCompatibility();
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
  await client.destroy().catch(() => {});
  await rm(paths.socket, { force: true });
  await removeQr();
  log.info('shutdown-complete', `signal=${signal}`);
  process.exit(exitCode);
}

async function main() {
  log.info('start', `chrome=${chromePath}`);
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