import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

test('package is npm-ready as whatseal with CLI and MCP bins', () => {
  assert.equal(pkg.name, 'whatseal');
  assert.equal(pkg.version, '2.0.3');
  assert.equal(pkg.mcpName, 'io.github.edosulai/whatseal');
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.bin, {
    whatseal: 'bin/whatseal.js',
    'whatseal-mcp': 'bin/whatseal-mcp.js',
  });
  for (const script of Object.values(pkg.bin)) {
    assert.match(script, /\.js$/);
  }
  assert.equal(pkg.engines.node, '>=22');
  assert.equal(pkg.publishConfig.access, 'public');
  assert.equal(pkg.repository.url, 'https://github.com/edosulai/whatseal-mcp.git');
  assert.equal(pkg.dependencies['whatsapp-web.js'], 'file:vendor/whatsapp-web.js');
  assert.equal(pkg.dependencies['puppeteer-core'], '24.38.0');
  assert.equal(pkg.dependencies.puppeteer, 'file:vendor/puppeteer');
  assert.equal(pkg.overrides.puppeteer, 'file:vendor/puppeteer');
});

test('vendor whatsapp-web.js requires puppeteer-core, not puppeteer', async () => {
  const wwebjs = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'vendor/whatsapp-web.js/package.json'), 'utf8'));
  assert.equal(wwebjs.version, '1.34.7');
  assert.equal(wwebjs.dependencies.puppeteer, undefined);
  assert.equal(wwebjs.dependencies['puppeteer-core'], '24.38.0');
  const client = await readFile(path.join(PROJECT_ROOT, 'vendor/whatsapp-web.js/src/Client.js'), 'utf8');
  assert.match(client, /require\('puppeteer-core'\)/);
  assert.equal(client.includes("require('puppeteer')"), false);
});

test('vendor puppeteer stub re-exports puppeteer-core without a postinstall', async () => {
  const stubPkg = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'vendor/puppeteer/package.json'), 'utf8'));
  assert.equal(stubPkg.name, 'puppeteer');
  assert.equal(stubPkg.scripts, undefined);
  const stub = await readFile(path.join(PROJECT_ROOT, 'vendor/puppeteer/index.cjs'), 'utf8');
  assert.match(stub, /require\('puppeteer-core'\)/);
});

test('published shrinkwrap does not fetch the real puppeteer tarball', () => {
  const shrinkwrap = require('../npm-shrinkwrap.json');
  const lockText = JSON.stringify(shrinkwrap);
  assert.equal(lockText.includes('puppeteer-24.38.0.tgz'), false);
  const core = shrinkwrap.packages['node_modules/puppeteer-core'];
  assert.equal(core.version, '24.38.0');
  assert.equal(core.hasInstallScript, undefined);
  const local = shrinkwrap.packages['node_modules/puppeteer'];
  assert.equal(local.hasInstallScript, undefined);
  assert.equal(local.resolved === undefined || /vendor\/puppeteer/.test(String(local.resolved)), true);
});

test('files allowlist ships runtime and docs, not live identity', () => {
  const files = pkg.files;
  for (const required of [
    'cli.mjs',
    'daemon.mjs',
    'mcp-server.mjs',
    'bin/',
    'mcp-wrapper.sh',
    'install-launchagent.sh',
    'lib/',
    'skills/whatseal/',
    'native-approval.swift',
    'accounts.example.json',
    'README.md',
    'server.json',
    'npm-shrinkwrap.json',
    'vendor/',
    'docs/assets/',
  ]) {
    assert.equal(files.includes(required), true, `missing ${required}`);
  }
  for (const forbidden of ['accounts.json', '.env', 'node_modules', 'web/', 'graphify-out/', 'assets/audio/']) {
    assert.equal(files.includes(forbidden), false, `must not pack ${forbidden}`);
  }
});

test('MCP registry metadata points at npm whatseal and does not claim Win/Linux sealed send', async () => {
  const server = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'server.json'), 'utf8'));
  assert.equal(server.name, 'io.github.edosulai/whatseal');
  assert.equal(server.version, '2.0.3');
  assert.equal(server.packages[0].registryType, 'npm');
  assert.equal(server.packages[0].identifier, 'whatseal');
  assert.equal(server.packages[0].transport.type, 'stdio');
  assert.equal(server.packages[0].runtimeHint, 'npx');
  assert.deepEqual(server.packages[0].packageArguments, ['mcp']);
  assert.match(server.description, /Touch ID|macOS/i);
  assert.equal(/windows hello|works on windows|linux polkit shipped/i.test(server.description), false);
});

test('npm pack dry-run stays on the files allowlist and drops live identity', async () => {
  const { execFileSync } = await import('node:child_process');
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const reports = JSON.parse(output);
  const files = reports.flatMap((entry) => (entry.files || []).map((file) => file.path || file));
  assert.equal(files.some((file) => file === 'bin/whatseal.js' || file.endsWith('/bin/whatseal.js')), true);
  assert.equal(files.some((file) => file === 'bin/whatseal-mcp.js' || file.endsWith('/bin/whatseal-mcp.js')), true);
  assert.equal(files.some((file) => file === 'server.json' || file.endsWith('/server.json')), true);
  assert.equal(files.some((file) => file === 'npm-shrinkwrap.json' || file.endsWith('/npm-shrinkwrap.json')), true);
  assert.equal(files.some((file) => file === 'vendor/puppeteer/index.cjs' || file.endsWith('/vendor/puppeteer/index.cjs')), true);
  assert.equal(files.some((file) => file === 'docs/assets/whatseal-mark.svg' || file.endsWith('docs/assets/whatseal-mark.svg')), true);
  assert.equal(files.some((file) => file === 'package-lock.json' || file.endsWith('/package-lock.json')), false,
    'npm pack always omits package-lock.json; bootstrap must not require npm ci');
  for (const forbidden of ['accounts.json', '.env', 'graphify-out', 'assets/audio']) {
    assert.equal(
      files.some((file) => file === forbidden || file.includes(`${forbidden}/`) || file.endsWith(`/${forbidden}`)),
      false,
      `tarball must not contain ${forbidden}`,
    );
  }
});
