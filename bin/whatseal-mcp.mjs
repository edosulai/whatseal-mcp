#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import { mcpPackageRoot, runMcpBootstrap } from '../lib/mcp-entry.mjs';

const root = mcpPackageRoot(import.meta.url);

await runMcpBootstrap({ root });

await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(root, 'cli.mjs'), 'install-skill'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.setEncoding?.('utf8');
  child.stderr?.on?.('data', (chunk) => {
    process.stderr.write(chunk);
  });
  child.once('error', (error) => {
    process.stderr.write(`whatseal-mcp: skill-install-failed ${error.message}\n`);
    resolve();
  });
  child.once('close', (status) => {
    if (status !== 0) {
      process.stderr.write('whatseal-mcp: skill-install-failed\n');
    }
    resolve();
  });
});

await import(new URL('../mcp-server.mjs', import.meta.url));
