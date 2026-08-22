import assert from 'node:assert/strict';
import test from 'node:test';

import { backendLifecycleCommands } from '../lib/core.mjs';
import {
  describeApprovalCapability,
  requestNativeApproval,
} from '../lib/native-approval.mjs';
import {
  assertPrivateControlSocket,
  describeControlTransport,
  listenControlSocket,
  removeStaleControlSocket,
} from '../lib/control-transport.mjs';
import {
  accountPaths,
  assertFilesystemControlSocketPath,
  controlTransportAddress,
  defaultAccountRoots,
  describeInstallSupport,
  describeLockPowerSupport,
  maxFilesystemControlSocketPathBytes,
  normalizePlatform,
  pathSecurityPassed,
  resolveAccountLayout,
  resolveAccountsFile,
  resolveChromePath,
  defaultChromeCandidates,
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

test('pathSecurityPassed ignores posix mode and missing uid on Windows', () => {
  const winProcess = {};
  assert.equal(pathSecurityPassed({
    typeOk: true,
    metadata: { uid: undefined, mode: 0o100666 },
    expectedMode: '0700',
    platform: 'win32',
    processRef: winProcess,
  }), true);
  assert.equal(pathSecurityPassed({
    typeOk: false,
    metadata: { uid: undefined, mode: 0o100666 },
    expectedMode: '0700',
    platform: 'win32',
    processRef: winProcess,
  }), false);
  assert.equal(pathSecurityPassed({
    typeOk: true,
    metadata: { uid: 501, mode: 0o100700, isDirectory: () => true },
    expectedMode: '0700',
    platform: 'darwin',
    processRef: { getuid: () => 501 },
  }), true);
  assert.equal(pathSecurityPassed({
    typeOk: true,
    metadata: { uid: 501, mode: 0o100777, isDirectory: () => true },
    expectedMode: '0700',
    platform: 'linux',
    processRef: { getuid: () => 501 },
  }), false);
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

test('filesystem control sockets fail closed past the AF_UNIX path limit', () => {
  assert.equal(maxFilesystemControlSocketPathBytes('darwin'), 103);
  assert.equal(maxFilesystemControlSocketPathBytes('linux'), 107);
  assert.equal(maxFilesystemControlSocketPathBytes('win32'), null);
  assert.equal(
    assertFilesystemControlSocketPath('/tmp/whatseal-state/control.sock', { platform: 'darwin' }),
    '/tmp/whatseal-state/control.sock',
  );
  const longPath = `/tmp/${'x'.repeat(120)}/control.sock`;
  assert.throws(
    () => assertFilesystemControlSocketPath(longPath, { platform: 'darwin' }),
    /AF_UNIX limit is 103/,
  );
  assert.equal(
    assertFilesystemControlSocketPath('\\\\.\\pipe\\whatsapp-agent-alice-deadbeefdeadbeef', { platform: 'win32' }),
    '\\\\.\\pipe\\whatsapp-agent-alice-deadbeefdeadbeef',
  );
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

test('backend lifecycle commands keep LaunchAgent install opt-in and session start everywhere', () => {
  const darwin = backendLifecycleCommands('alpha', '/tmp/whatseal-mcp', { platform: 'darwin' });
  assert.match(darwin.install, /install-launchagent\.sh install --account alpha/);
  assert.equal(darwin.start, 'node cli.mjs start --account alpha');
  assert.equal(darwin.stop, 'node cli.mjs stop --account alpha');
  assert.equal(darwin.qrCli, 'node cli.mjs qr --account alpha');

  const linux = backendLifecycleCommands('alpha', '/tmp/whatseal-mcp', { platform: 'linux' });
  assert.match(linux.install, /not shipped/i);
  assert.equal(linux.start, 'node cli.mjs start --account alpha');
  assert.equal(linux.stop, 'node cli.mjs stop --account alpha');
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

function fakeHelperStat({ uid = process.getuid?.() ?? 501, mode = 0o100500 } = {}) {
  return {
    isSymbolicLink: () => false,
    isFile: () => true,
    uid,
    mode,
  };
}

function fakeHelperProcess(exitCode, { stderr = '' } = {}) {
  let payload = null;
  const spawnImpl = () => {
    const child = {
      stderr: {
        setEncoding() {},
        on(event, fn) {
          if (event === 'data' && stderr) queueMicrotask(() => fn(stderr));
        },
      },
      stdin: {
        end(value) {
          payload = value;
        },
      },
      once(event, fn) {
        if (event === 'close') queueMicrotask(() => fn(exitCode));
      },
    };
    return child;
  };
  return {
    spawnImpl,
    payload: () => payload,
  };
}

test('Darwin helper spawn maps approve, decline, and unexpected exits', async () => {
  const approved = fakeHelperProcess(0);
  assert.equal(
    await requestNativeApproval({ target: 'chat', text: 'hi', action: 'send' }, {
      helperPath: '/tmp/native-approval',
      platform: 'darwin',
      lstatImpl: async () => fakeHelperStat(),
      spawnImpl: approved.spawnImpl,
    }),
    true,
  );
  assert.match(String(approved.payload()), /"action":"send"/);

  const declined = fakeHelperProcess(2);
  assert.equal(
    await requestNativeApproval({ text: 'hi' }, {
      helperPath: '/tmp/native-approval',
      platform: 'darwin',
      lstatImpl: async () => fakeHelperStat(),
      spawnImpl: declined.spawnImpl,
    }),
    false,
  );

  const failed = fakeHelperProcess(1, { stderr: 'helper exploded' });
  await assert.rejects(
    () => requestNativeApproval({ text: 'hi' }, {
      helperPath: '/tmp/native-approval',
      platform: 'darwin',
      lstatImpl: async () => fakeHelperStat(),
      spawnImpl: failed.spawnImpl,
    }),
    /exit 1: helper exploded/,
  );
});

test('Windows control transport skips filesystem socket chmod and unlink', async () => {
  let chmodCalled = false;
  let rmCalled = false;
  const pipe = '\\\\.\\pipe\\whatsapp-agent-alice-deadbeef';
  await listenControlSocket({
    once() {},
    listen(_path, resolve) {
      resolve();
    },
  }, pipe, {
    platform: 'win32',
    chmodImpl: async () => {
      chmodCalled = true;
    },
  });
  assert.equal(chmodCalled, false);

  const removed = await removeStaleControlSocket(pipe, {
    platform: 'win32',
    rmImpl: async () => {
      rmCalled = true;
    },
  });
  assert.equal(removed, false);
  assert.equal(rmCalled, false);
});

test('assertPrivateControlSocket enforces 0600 on Unix and skips Windows', () => {
  assert.equal(assertPrivateControlSocket({
    isSocket: () => true,
    mode: 0o100600,
  }, { platform: 'darwin' }), true);
  assert.throws(
    () => assertPrivateControlSocket({
      isSocket: () => true,
      mode: 0o100666,
    }, { platform: 'darwin' }),
    /expected 0600/,
  );
  assert.equal(assertPrivateControlSocket({
    isSocket: () => false,
    mode: 0o100666,
  }, { platform: 'win32' }), true);
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

  const win = accountPaths('alpha', {
    platform: 'win32',
    homedir: '/tmp/whatseal-home',
    env: {
      WHATSAPP_AGENT_ROOT: '/tmp/custom-root',
      WHATSAPP_AGENT_STATE: '/tmp/custom-state',
      USERNAME: 'alice',
    },
  });
  assert.equal(win.root, '/tmp/custom-root/alpha');
  assert.equal(win.state, '/tmp/custom-state/alpha');
  assert.match(win.socket, /^\\\\\.\\pipe\\whatsapp-agent-alice-[0-9a-f]{16}$/);
});

test('accounts.json lives in user state, not the npm package root', () => {
  const userPath = resolveAccountsFile({
    platform: 'darwin',
    homedir: '/tmp/whatseal-home',
    projectRoot: '/opt/whatseal',
    env: {},
    existsSync: () => false,
  });
  assert.equal(userPath, '/tmp/whatseal-home/.local/state/whatsapp-agent/accounts.json');

  const checkoutPath = resolveAccountsFile({
    platform: 'darwin',
    homedir: '/tmp/whatseal-home',
    projectRoot: '/opt/whatseal',
    env: {},
    existsSync: (target) => target === '/opt/whatseal/accounts.json',
  });
  assert.equal(checkoutPath, '/opt/whatseal/accounts.json');

  const envPath = resolveAccountsFile({
    platform: 'darwin',
    homedir: '/tmp/whatseal-home',
    projectRoot: '/opt/whatseal',
    env: { WHATSEAL_ACCOUNTS: '/tmp/custom-accounts.json' },
    existsSync: () => false,
  });
  assert.equal(envPath, '/tmp/custom-accounts.json');
});

test('resolveChromePath prefers env, then platform candidates', async () => {
  assert.equal(
    await resolveChromePath({ env: { WHATSAPP_CHROME_PATH: '/opt/chrome' }, existsSync: () => false }),
    '/opt/chrome',
  );
  assert.equal(
    await resolveChromePath({
      env: {},
      platform: 'darwin',
      existsSync: (target) => target === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    }),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  );
  assert.deepEqual(defaultChromeCandidates('linux')[0], '/usr/bin/google-chrome-stable');
  await assert.rejects(
    () => resolveChromePath({ env: {}, platform: 'darwin', existsSync: () => false }),
    /WHATSAPP_CHROME_PATH/,
  );
});
