#!/usr/bin/env node
import { copyFile, stat } from 'node:fs/promises';

import { createLogger, parseCommonArgs, paths, rpcCall, writeJsonAtomic } from './lib/core.mjs';
import { assertPrivateControlSocket } from './lib/control-transport.mjs';
import { requestNativeApproval } from './lib/native-approval.mjs';

const args = process.argv.slice(2);
const { verbose, help } = parseCommonArgs(args);
const log = createLogger('whatsapp-baseline-approval', verbose);
const approve = args.includes('--approve-current');
const baselinePath = paths.compatibilityBaseline;
const approvalHelper = `${paths.state}/native-baseline-approval`;

function usage() {
  process.stdout.write(`Usage: node approve-baseline.mjs --approve-current [--verbose|-v]\n\nRuns the content-free compatibility self-test and promotes the current runtime\nas the last-known-good baseline. This command is intentionally not exposed via\nMCP. Review the printed version report before running it.\n`);
}

async function main() {
  log.info('start', `approve=${approve}`);
  if (help) {
    usage();
    log.info('complete', 'help');
    return;
  }
  if (!approve) throw new Error('Refusing baseline promotion without --approve-current.');

  log.info('progress', '[0/5] 0% — running content-free compatibility self-test');
  const test = await rpcCall('compatibilitySelfTest', {}, { timeoutMs: 10000 });
  if (!test.passed || test.contentReturned !== false) {
    throw new Error('Compatibility self-test did not pass without content.');
  }

  log.info('progress', '[1/5] 20% — verifying private control socket mode');
  const socket = await stat(paths.socket);
  assertPrivateControlSocket(socket);
  const socketMode = (socket.mode & 0o777).toString(8).padStart(4, '0');

  log.info('progress', '[2/5] 40% — building immutable version tuple');
  const report = test.compatibility;
  if (report.backend.backendSourceMatchesStartup !== true) {
    throw new Error('Backend source on disk does not match the source loaded at daemon startup. Restart before approval.');
  }
  const baseline = {
    schemaVersion: 1,
    approvedAt: new Date().toISOString(),
    approved: {
      whatsappWebVersion: report.runtime.whatsappWebVersion,
      browserVersion: report.runtime.browserVersion,
      nodeVersion: report.runtime.nodeVersion,
      platform: report.runtime.platform,
      backendVersion: report.backend.version,
      whatsappWebJsVersion: report.backend.whatsappWebJsVersion,
      whatsappWebJsSource: report.backend.whatsappWebJsSource,
      whatsappWebJsResolved: report.backend.whatsappWebJsResolved,
      whatsappWebJsIntegrity: report.backend.whatsappWebJsIntegrity,
      packageLockSha256: report.backend.packageLockSha256,
      backendStartupSourceSha256: report.backend.backendStartupSourceSha256,
      backendCurrentDiskSourceSha256: report.backend.backendCurrentDiskSourceSha256,
      backendSourceMatchesStartup: report.backend.backendSourceMatchesStartup,
      installedDependenciesStartupSha256: report.backend.installedDependenciesStartupSha256,
      messageApprovalHelperSha256: report.backend.messageApprovalHelperSha256,
      baselineApprovalHelperSha256: report.backend.baselineApprovalHelperSha256,
      mcpSdkVersion: report.backend.mcpSdkVersion,
      qrcodeVersion: report.backend.qrcodeVersion,
      zodVersion: report.backend.zodVersion,
    },
    acceptance: {
      backendReady: test.phase === 'ready',
      connectionState: test.state,
      contentFreeSelfTest: test.passed,
      contentReturned: test.contentReturned,
      chatCollectionCount: test.pageProbe.chatCount,
      privateSocketMode: socketMode,
      devtoolsTcpPort: false,
      messagePreviewDefault: false,
      nativeUserAuthenticationForSend: true,
    },
  };
  process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);

  log.info('progress', '[3/5] 60% — requiring native user-presence approval');
  const authorized = await requestNativeApproval(baseline.approved, { helperPath: approvalHelper });
  if (!authorized) throw new Error('Compatibility baseline approval was declined.');

  log.info('progress', '[4/5] 80% — preserving previous baseline when present');
  try {
    await copyFile(baselinePath, `${baselinePath}.previous`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  log.info('progress', '[5/5] 100% — writing last-known-good baseline');
  await writeJsonAtomic(baselinePath, baseline, 0o600);
  log.info('complete', `baseline=${baselinePath}`);
}

main().catch((error) => {
  log.error('failed', error.message);
  process.exitCode = 1;
});