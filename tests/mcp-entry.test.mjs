import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  dependencyBootstrapNeeded,
  dependencyBootstrapSpec,
  mcpPackageRoot,
  runMcpBootstrap,
} from '../lib/mcp-entry.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('MCP bin is Node with a shebang and lives beside the package root', async () => {
  const binPath = path.join(PROJECT_ROOT, 'bin', 'whatseal-mcp.mjs');
  const body = await readFile(binPath, 'utf8');
  assert.match(body, /^#!\/usr\/bin\/env node\n/);
  assert.equal(mcpPackageRoot(new URL(`file://${binPath}`).href), PROJECT_ROOT);
});

test('npm bin wrappers are .js shims so npx can link them', async () => {
  for (const name of ['whatseal.js', 'whatseal-mcp.js']) {
    const wrapper = path.join(PROJECT_ROOT, 'bin', name);
    const body = await readFile(wrapper, 'utf8');
    assert.match(body, /^#!\/usr\/bin\/env node\n/);
    assert.match(body, /\.mjs/);
  }
});

test('bootstrap is a no-op when @modelcontextprotocol is already installed', async () => {
  const root = '/tmp/whatseal-installed';
  const existsSync = (target) => target === path.join(root, 'node_modules', '@modelcontextprotocol');
  assert.equal(dependencyBootstrapNeeded(root, { existsSync }), false);

  const calls = [];
  const logs = [];
  await runMcpBootstrap({
    root,
    existsSync,
    spawn: async (...args) => {
      calls.push(args);
      return { status: 0 };
    },
    log: (line) => logs.push(line),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, []);
});

test('bootstrap uses npm ci when a lockfile is present, else npm install', () => {
  const root = '/opt/whatseal';
  const withLock = (target) => target === path.join(root, 'npm-shrinkwrap.json');
  const withoutLock = () => false;

  assert.deepEqual(dependencyBootstrapSpec(root, { existsSync: withLock }).args.slice(0, 1), ['ci']);
  assert.deepEqual(dependencyBootstrapSpec(root, { existsSync: withoutLock }).args.slice(0, 1), ['install']);
});

test('bootstrap runs npm with puppeteer skip-download and never writes stdout', async () => {
  const root = '/opt/whatseal';
  const existsSync = () => false;
  assert.equal(dependencyBootstrapNeeded(root, { existsSync }), true);

  const spec = dependencyBootstrapSpec(root, { existsSync });
  assert.equal(spec.command, 'npm');
  assert.deepEqual(spec.args, [
    'install',
    '--prefix',
    root,
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
  ]);
  assert.equal(spec.env.PUPPETEER_SKIP_DOWNLOAD, 'true');

  const writes = [];
  const originalWrite = process.stdout.write;
  const spawned = [];
  try {
    process.stdout.write = (...args) => {
      writes.push(args[0]);
      return true;
    };
    await runMcpBootstrap({
      root,
      existsSync,
      spawn: async (command, args, options) => {
        spawned.push({ command, args, options });
        return { status: 0 };
      },
      log: () => {},
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, 'npm');
  assert.equal(spawned[0].options.env.PUPPETEER_SKIP_DOWNLOAD, 'true');
  assert.equal(writes.length, 0);
});

test('mcp-wrapper.sh is a thin exec of the Node MCP bin', async () => {
  const body = await readFile(path.join(PROJECT_ROOT, 'mcp-wrapper.sh'), 'utf8');
  assert.match(body, /bin\/whatseal-mcp\.mjs/);
  assert.equal(body.includes('npm ci --prefix'), false);
});
