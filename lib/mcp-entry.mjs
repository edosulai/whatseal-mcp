import { spawn as spawnChild } from 'node:child_process';
import { existsSync as fsExistsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MCP_DEPENDENCY_DIR = path.join('node_modules', '@modelcontextprotocol');

export function mcpPackageRoot(moduleUrl) {
  return path.dirname(path.dirname(fileURLToPath(moduleUrl)));
}

export function dependencyBootstrapNeeded(root, { existsSync = fsExistsSync } = {}) {
  return !existsSync(path.join(root, MCP_DEPENDENCY_DIR));
}

export function dependencyBootstrapSpec(root, { existsSync = fsExistsSync } = {}) {
  const hasLock = existsSync(path.join(root, 'package-lock.json'))
    || existsSync(path.join(root, 'npm-shrinkwrap.json'));
  return {
    command: 'npm',
    args: [
      hasLock ? 'ci' : 'install',
      '--prefix',
      root,
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
    ],
    env: { PUPPETEER_SKIP_DOWNLOAD: 'true' },
  };
}

function defaultSpawn(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(command, args, options);
    let stderr = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stderr }));
  });
}

export async function runMcpBootstrap({
  root,
  existsSync = fsExistsSync,
  spawn = defaultSpawn,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  if (!root) throw new Error('whatseal-mcp bootstrap requires a package root.');
  if (!dependencyBootstrapNeeded(root, { existsSync })) {
    return { skipped: true };
  }

  const spec = dependencyBootstrapSpec(root, { existsSync });
  log(`whatseal-mcp bootstrap: installing dependencies in ${root}`);
  const result = await spawn(spec.command, spec.args, {
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (result?.status !== 0) {
    if (result?.stderr) log(String(result.stderr).trim());
    throw new Error(`whatseal-mcp bootstrap failed (npm ${spec.args[0]} exited ${result?.status ?? 'unknown'}).`);
  }
  log('whatseal-mcp bootstrap: complete');
  return { skipped: false };
}
