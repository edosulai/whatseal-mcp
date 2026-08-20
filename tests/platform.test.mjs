import assert from 'node:assert/strict';
import test from 'node:test';

import { backendLifecycleCommands } from '../lib/core.mjs';
import {
  describeApprovalCapability,
  requestNativeApproval,
} from '../lib/native-approval.mjs';
import {
  describeControlTransport,
} from '../lib/control-transport.mjs';
import {
  accountPaths,
  controlTransportAddress,
  defaultAccountRoots,
  describeInstallSupport,
  describeLockPowerSupport,
  normalizePlatform,
  resolveAccountLayout,
  supportsPosixModes,
  usesFilesystemControlSocket,
} from '../lib/platform.mjs';

test('normalizePlatform maps win prefixes and keeps darwin/linux', () => {
  assert.equal(normalizePlatform('darwin'), 'darwin');
  assert.equal(normalizePlatform('linux'), 'linux');
  assert.equal(normalizePlatform('win32'), 'win32');
  assert.equal(normalizePlatform('Windows_NT'), 'win32');
});

test('posix modes and filesystem sockets stay fail-closed on Windows', () => {
  assert.equal(supportsPosixModes('darwin'), true);
  assert.equal(supportsPosixModes('linux'), true);
  assert.equal(supportsPosixModes('win32'), false);
  assert.equal(usesFilesystemControlSocket('darwin'), true);
  assert.equal(usesFilesystemControlSocket('linux'), true);
  assert.equal(usesFilesystemControlSocket('win32'), false);
});

test('default account roots keep Darwin paths and use XDG / LocalAppData elsewhere', () => {
  const darwin = defaultAccountRoots({
    platform: 'darwin',
    homedir: '/tmp/whatseal-home',
    env: {},
  });
  assert.equal(darwin.root, '/tmp/whatseal-home/.local/share/whatsapp-agent');
  assert.equal(darwin.state, '/tmp/whatseal-home/.local/state/whatsapp-agent');

  const linux = defaultAccountRoots({
    platform: 'linux',
    homedir: '/tmp/whatseal-home',
    env: {},
  });
  assert.equal(linux.root, '/tmp/whatseal-home/.local/share/whatsapp-agent');
  assert.equal(linux.state, '/tmp/whatseal-home/.local/state/whatsapp-agent');

  const win = defaultAccountRoots({
    platform: 'win32',
    homedir: '/tmp/whatseal-home',
    env: {},
  });
  assert.equal(win.root, '/tmp/whatseal-home/AppData/Local/whatsapp-agent/data');
  assert.equal(win.state, '/tmp/whatseal-home/AppData/Local/whatsapp-agent/state');
});

test('Windows control transport is a named pipe, not a filesystem socket', () => {
  const addr = controlTransportAddress('/tmp/whatseal-state', {
    platform: 'win32',
    env: { USERNAME: 'alice' },
  });
  assert.match(addr, /^\\\\\.\\pipe\\whatsapp-agent-alice-[0-9a-f]{16}$/);
  assert.equal(addr.includes('/tmp/whatseal-state'), false);

  const unix = controlTransportAddress('/tmp/whatseal-state', { platform: 'darwin', env: {} });
  assert.equal(unix, '/tmp/whatseal-state/control.sock');

  assert.equal(describeControlTransport('win32').kind, 'named-pipe');
  assert.equal(describeControlTransport('darwin').kind, 'unix-socket');
});

test('accountPaths stays compatible and exposes per-account Darwin sockets', () => {
  const paths = accountPaths('alpha', {
    platform: 'darwin',
    homedir: '/tmp/whatseal-home',
    env: {},
  });
  assert.equal(paths.root, '/tmp/whatseal-home/.local/share/whatsapp-agent/alpha');
  assert.equal(paths.socket, '/tmp/whatseal-home/.local/state/whatsapp-agent/alpha/control.sock');
  assert.equal(paths.messageApprovalHelper.endsWith('/native-approval'), true);
  assert.equal(paths.platform, 'darwin');
});

test('install and lock-power stay Darwin-only; others degrade safe', () => {
  const darwin = describeInstallSupport('darwin');
  assert.equal(darwin.supported, true);
  assert.equal(darwin.script, 'install-launchagent.sh');

  const linux = describeInstallSupport('linux');
  assert.equal(linux.supported, false);
  assert.match(linux.reason, /not shipped/i);

  const win = describeInstallSupport('win32');
  assert.equal(win.supported, false);
  assert.match(win.reason, /not shipped/i);

  assert.equal(describeLockPowerSupport('darwin').supported, true);
  assert.equal(describeLockPowerSupport('linux').supported, false);
  assert.equal(describeLockPowerSupport('win32').supported, false);
});

test('backend lifecycle commands keep LaunchAgent on Darwin and refuse install elsewhere', () => {
  const darwin = backendLifecycleCommands('alpha', '/tmp/whatseal-mcp', { platform: 'darwin' });
  assert.match(darwin.install, /install-launchagent\.sh install --account alpha/);
  assert.match(darwin.start, /install-launchagent\.sh start --account alpha/);

  const linux = backendLifecycleCommands('alpha', '/tmp/whatseal-mcp', { platform: 'linux' });
  assert.match(linux.install, /not shipped/i);
  assert.match(linux.start, /not shipped/i);
  assert.match(linux.status, /node cli\.mjs status --account alpha/);
  assert.equal(linux.qrCli, 'node cli.mjs qr --account alpha');
});

test('sealed approval stays fail-closed off Darwin', async () => {
  assert.equal(describeApprovalCapability('darwin').supported, true);
  assert.equal(describeApprovalCapability('linux').supported, false);
  assert.equal(describeApprovalCapability('win32').supported, false);
  await assert.rejects(
    () => requestNativeApproval({ text: 'hi' }, { helperPath: '/tmp/native-approval', platform: 'linux' }),
    /not implemented on linux/i,
  );
});

test('resolveAccountLayout honors WHATSAPP_AGENT_ROOT overrides', () => {
  const layout = resolveAccountLayout({
    accountId: 'beta',
    platform: 'linux',
    homedir: '/tmp/whatseal-home',
    env: {
      WHATSAPP_AGENT_ROOT: '/tmp/custom-root',
      WHATSAPP_AGENT_STATE: '/tmp/custom-state',
    },
  });
  assert.equal(layout.root, '/tmp/custom-root/beta');
  assert.equal(layout.state, '/tmp/custom-state/beta');
  assert.equal(layout.socket, '/tmp/custom-state/beta/control.sock');
});
