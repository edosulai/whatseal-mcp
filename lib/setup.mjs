import { access, copyFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { describeApprovalCapability } from './native-approval.mjs';
import { describeInstallSupport, normalizePlatform, resolveAccountsFile } from './platform.mjs';
import { DEFAULT_SKILL_PLATFORMS, installSkill } from './skill-install.mjs';

const SETUP_CLIENTS = new Set(['all', 'hermes', 'claude', 'cursor', 'vscode']);

export function parseSetupArgs(argv = []) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const command = args[0] || 'setup';
  let client = 'all';
  let account = null;
  let installAgent = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--install-agent') {
      installAgent = true;
      continue;
    }
    if ((value === '--client' || value === '--account') && index + 1 < args.length) {
      if (value === '--client') client = args[index + 1];
      if (value === '--account') account = args[index + 1];
      index += 1;
    }
  }
  if (!SETUP_CLIENTS.has(client)) {
    const error = new Error(`Unknown setup client: ${client}`);
    error.code = 'UNKNOWN_SETUP_CLIENT';
    throw error;
  }
  return { command, client, account, installAgent };
}

export function mcpClientSnippets() {
  const stdio = { command: 'npx', args: ['-y', 'whatseal', 'mcp'] };
  return {
    stdio,
    claudeJson: `${JSON.stringify({
      mcpServers: {
        whatseal: {
          command: stdio.command,
          args: stdio.args,
        },
      },
    }, null, 2)}\n`,
    vscodeJson: `${JSON.stringify({
      servers: {
        whatseal: {
          type: 'stdio',
          command: stdio.command,
          args: stdio.args,
        },
      },
    }, null, 2)}\n`,
    hermesAdd: "printf 'Y\\n' | hermes mcp add whatseal --command npx --args -y --args whatseal --args mcp",
    hermesYaml: 'mcp_servers:\n  whatseal:\n    command: npx\n    args: ["-y", "whatseal", "mcp"]\n',
  };
}

export function chromeLookupPaths(platform = process.platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  if (normalized === 'linux') {
    return [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ];
  }
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
}

function parseNodeMajor(raw) {
  const match = String(raw || '').replace(/^v/i, '').match(/^(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function defaultChromeExists(platform, env) {
  if (env?.WHATSAPP_CHROME_PATH) return pathExists(env.WHATSAPP_CHROME_PATH);
  for (const candidate of chromeLookupPaths(platform)) {
    if (await pathExists(candidate)) return true;
  }
  return false;
}

export async function runSetup({
  platform = process.platform,
  nodeVersion = process.version,
  projectRoot = process.cwd(),
  homeDir = os.homedir(),
  env = process.env,
  chromeExists,
  installSkillImpl = installSkill,
  installAgentImpl,
  version = '2.0.0',
  installAgent = false,
  account = null,
} = {}) {
  const normalized = normalizePlatform(platform);
  const sealedSend = describeApprovalCapability(normalized);
  const installSupport = describeInstallSupport(normalized);
  const warnings = [];
  const nodeMajor = parseNodeMajor(nodeVersion);
  const checks = {
    node: {
      ok: nodeMajor >= 22,
      version: String(nodeVersion).replace(/^v/i, ''),
      required: '>=22',
    },
    chrome: {
      ok: false,
      path: env.WHATSAPP_CHROME_PATH || chromeLookupPaths(normalized)[0] || null,
    },
  };

  checks.chrome.ok = chromeExists
    ? Boolean(await chromeExists({ platform: normalized, env, paths: chromeLookupPaths(normalized) }))
    : await defaultChromeExists(normalized, env);

  const examplePath = path.join(projectRoot, 'accounts.example.json');
  const accountsPath = resolveAccountsFile({
    platform: normalized,
    env,
    homedir: homeDir,
    projectRoot,
  });
  const existed = await pathExists(accountsPath);
  let copied = false;
  if (!existed) {
    await mkdir(path.dirname(accountsPath), { recursive: true, mode: 0o700 });
    await copyFile(examplePath, accountsPath);
    copied = true;
  }

  const skill = await installSkillImpl({
    projectRoot,
    platforms: [...DEFAULT_SKILL_PLATFORMS],
    homeDir,
    version,
  });

  const launchAgent = {
    offered: Boolean(installSupport.supported),
    installed: false,
    command: installSupport.supported
      ? `${path.join(projectRoot, installSupport.script)} install${account ? ` --account ${account}` : ''}`
      : null,
    reason: installSupport.reason,
  };

  if (installAgent) {
    if (!installSupport.supported) {
      warnings.push(installSupport.reason || `Background service install is not shipped on ${normalized}.`);
    } else if (typeof installAgentImpl === 'function') {
      await installAgentImpl({
        script: path.join(projectRoot, installSupport.script),
        account,
        projectRoot,
      });
      launchAgent.installed = true;
    }
  }

  if (!sealedSend.supported) {
    warnings.push(
      `Sealed send is fail-closed on ${normalized}. ${sealedSend.reason} This is not a finished product on Windows/Linux; a local emulator is planned, not shipped.`,
    );
  }

  const snippets = mcpClientSnippets();
  const nextSteps = [];
  if (normalized === 'darwin') {
    nextSteps.push('Scan the pairing QR: `whatseal qr` then WhatsApp → Settings → Linked Devices → Link a Device.');
    nextSteps.push('Wait until ready: `whatseal wait-ready` / `whatseal status`.');
    if (!launchAgent.installed && launchAgent.command) {
      nextSteps.push(`Persistent backend is opt-in. Re-run with --install-agent to run: ${launchAgent.command}`);
    }
    nextSteps.push('Paste the MCP snippet into Claude Desktop / Cursor / VS Code, or run the Hermes add command.');
  } else {
    nextSteps.push('Do not list this OS as supported for sealed send. Reads-only adapters and emulators are not a finished product yet.');
  }

  return {
    ok: true,
    platform: normalized,
    sealedSend,
    checks,
    accounts: { copied, existed, path: accountsPath },
    skill,
    launchAgent,
    snippets,
    nextSteps,
    warnings,
  };
}

export function formatSetupReport(result) {
  const lines = [
    `whatseal setup (${result.platform})`,
    `sealed send: ${result.sealedSend.supported ? 'Touch ID / login password' : 'fail-closed'}`,
    `node: ${result.checks.node.ok ? 'ok' : 'needs >=22'} (${result.checks.node.version})`,
    `chrome: ${result.checks.chrome.ok ? 'ok' : 'missing'}`,
    `accounts.json: ${result.accounts.copied ? 'copied from example' : 'kept existing'}`,
  ];
  if (result.warnings.length > 0) {
    lines.push('warnings:');
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }
  lines.push('next:');
  for (const step of result.nextSteps) lines.push(`- ${step}`);
  lines.push('');
  lines.push('Claude Desktop / Cursor snippet:');
  lines.push(result.snippets.claudeJson.trimEnd());
  lines.push('');
  lines.push('Hermes:');
  lines.push(result.snippets.hermesAdd);
  lines.push('');
  return `${lines.join('\n')}\n`;
}
