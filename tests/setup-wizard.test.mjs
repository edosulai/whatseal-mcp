import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  chromeLookupPaths,
  mcpClientSnippets,
  parseSetupArgs,
  runSetup,
} from '../lib/setup.mjs';

test('parseSetupArgs reads client, account, and explicit agent-install flag', () => {
  assert.deepEqual(parseSetupArgs(['setup']), {
    command: 'setup',
    client: 'all',
    account: null,
    installAgent: false,
  });
  assert.deepEqual(parseSetupArgs(['setup', '--client', 'hermes', '--account', 'alpha', '--install-agent']), {
    command: 'setup',
    client: 'hermes',
    account: 'alpha',
    installAgent: true,
  });
});

test('MCP snippets launch npx whatseal mcp, not a local bash wrapper', () => {
  const snippets = mcpClientSnippets();
  assert.deepEqual(snippets.stdio, { command: 'npx', args: ['-y', 'whatseal', 'mcp'] });
  assert.match(snippets.claudeJson, /"command": "npx"/);
  assert.match(snippets.claudeJson, /"whatseal"/);
  assert.match(snippets.claudeJson, /"mcp"/);
  assert.match(snippets.hermesAdd, /hermes mcp add whatseal --command npx/);
  assert.match(snippets.hermesAdd, /--args -y --args whatseal --args mcp/);
  assert.equal(snippets.stdio.command.includes('mcp-wrapper.sh'), false);
});

test('Darwin chrome lookup prefers the system app and env override', () => {
  assert.deepEqual(chromeLookupPaths('darwin'), ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
  assert.equal(chromeLookupPaths('linux').length > 0, true);
  assert.equal(chromeLookupPaths('win32').length > 0, true);
});

test('Darwin setup copies missing accounts, installs skill, and does not autostart', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'whatseal-setup-home-'));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'whatseal-setup-proj-'));
  try {
    await writeFile(
      path.join(projectDir, 'accounts.example.json'),
      `${JSON.stringify({ default: 'alpha', accounts: [{ id: 'alpha', alias: 'work', description: 'Work' }] }, null, 2)}\n`,
    );
    const agentCalls = [];
    const result = await runSetup({
      platform: 'darwin',
      nodeVersion: '22.14.0',
      projectRoot: projectDir,
      homeDir,
      env: {},
      chromeExists: async () => true,
      installSkillImpl: async (options) => ({
        skillName: 'whatseal',
        version: '2.0.0',
        project: false,
        installed: options.platforms.map((platform) => ({ platform, path: `${homeDir}/${platform}` })),
      }),
      installAgentImpl: async (args) => {
        agentCalls.push(args);
        return { ok: true };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.sealedSend.supported, true);
    assert.equal(result.checks.node.ok, true);
    assert.equal(result.checks.chrome.ok, true);
    assert.equal(result.accounts.copied, true);
    assert.equal(result.accounts.path, path.join(homeDir, '.local/state/whatsapp-agent/accounts.json'));
    const copied = JSON.parse(await readFile(result.accounts.path, 'utf8'));
    assert.equal(copied.default, 'alpha');
    await assert.rejects(readFile(path.join(projectDir, 'accounts.json')), { code: 'ENOENT' });
    assert.equal(result.launchAgent.offered, true);
    assert.equal(result.launchAgent.installed, false);
    assert.equal(agentCalls.length, 0);
    assert.match(result.nextSteps.join('\n'), /whatseal qr/);
    assert.match(result.nextSteps.join('\n'), /starts a session daemon/);
    assert.equal(result.snippets.stdio.command, 'npx');
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('setup never overwrites an existing accounts.json', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'whatseal-setup-keep-'));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'whatseal-setup-keep-proj-'));
  try {
    await writeFile(path.join(projectDir, 'accounts.example.json'), '{"default":"example"}\n');
    await writeFile(path.join(projectDir, 'accounts.json'), '{"default":"live","accounts":[]}\n');
    const result = await runSetup({
      platform: 'darwin',
      nodeVersion: '22.14.0',
      projectRoot: projectDir,
      homeDir,
      env: {},
      chromeExists: async () => true,
      installSkillImpl: async () => ({ installed: [] }),
      installAgentImpl: async () => {
        throw new Error('should not install agent');
      },
    });
    assert.equal(result.accounts.copied, false);
    assert.equal(result.accounts.existed, true);
    const kept = await readFile(path.join(projectDir, 'accounts.json'), 'utf8');
    assert.match(kept, /"live"/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('Linux and Windows setup stay fail-closed and do not claim a finished product', async () => {
  for (const platform of ['linux', 'win32']) {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), `whatseal-setup-${platform}-home-`));
    const projectDir = await mkdtemp(path.join(os.tmpdir(), `whatseal-setup-${platform}-proj-`));
    try {
      await writeFile(
        path.join(projectDir, 'accounts.example.json'),
        '{"default":"alpha","accounts":[]}\n',
      );
      const result = await runSetup({
        platform,
        nodeVersion: '22.14.0',
        projectRoot: projectDir,
        homeDir,
        env: {},
        chromeExists: async () => true,
        installSkillImpl: async () => ({ installed: [{ platform: 'hermes', path: `${homeDir}/skill` }] }),
        installAgentImpl: async () => {
          throw new Error(`must not install a background service on ${platform}`);
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.sealedSend.supported, false);
      assert.match(result.sealedSend.reason, /fail-closed|not implemented/i);
      assert.equal(result.launchAgent.offered, false);
      assert.equal(result.launchAgent.installed, false);
      assert.match(result.warnings.join('\n'), /not a finished product|emulator/i);
      assert.match(result.warnings.join('\n'), /Windows Hello|polkit|Touch ID/i);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  }
});
