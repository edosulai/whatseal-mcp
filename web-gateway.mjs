#!/usr/bin/env node
/**
 * Single public web gateway for whatseal.
 *
 * User-facing: http://127.0.0.1:3000 only.
 * Account selection: X-Whatseal-Account header or ?account= (default from accounts.json).
 * Per-account daemons keep private localhost ports (30000 + last 4 digits); users never see them.
 */
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import express from 'express';

import {
  accountPaths,
  createLogger,
  parseCommonArgs,
  rpcCall,
} from './lib/core.mjs';

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const { verbose } = parseCommonArgs(process.argv.slice(2));
const log = createLogger('whatseal-web-gateway', verbose);

const PUBLIC_PORT = Number(process.env.WHATSEAL_WEB_PORT || process.env.PORT || 3000);
const ACCOUNTS_PATH = process.env.WHATSEAL_ACCOUNTS_PATH
  || path.join(sourceRoot, 'accounts.json');

function resolveInternalHttpPort(id = null) {
  const fromEnv = Number(process.env.WHATSAPP_HTTP_PORT || 0);
  if (Number.isInteger(fromEnv) && fromEnv >= 1 && fromEnv <= 65535) return fromEnv;
  const digits = String(id ?? 'alpha').replace(/\D/g, '') || '0001';
  const last4 = digits.slice(-4).padStart(4, '0');
  return 30000 + Number.parseInt(last4, 10);
}

async function loadAccountsConfig() {
  try {
    const raw = await readFile(ACCOUNTS_PATH, 'utf8');
    const config = JSON.parse(raw);
    const accounts = Array.isArray(config?.accounts) ? config.accounts : [];
    return {
      default: config?.default || accounts[0]?.id || 'alpha',
      accounts,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { default: 'alpha', accounts: [{ id: 'alpha', alias: 'work', description: '' }] };
    }
    throw error;
  }
}

function resolveAccountId(req, config) {
  const header = req.get('x-whatseal-account') || req.get('x-account');
  const query = typeof req.query.account === 'string' ? req.query.account : null;
  const requested = (header || query || config.default || 'alpha').trim();
  const match = config.accounts.find(
    (entry) => entry.id === requested || entry.alias === requested,
  );
  if (match) return match.id;
  // Allow raw id even if not listed (dev convenience).
  if (/^[\w.+-]+$/.test(requested)) return requested;
  return config.default || 'alpha';
}

async function backendStatus(accountId) {
  const paths = accountPaths(accountId);
  try {
    const live = await rpcCall('status', {}, { timeoutMs: 2500, socketPath: paths.socket });
    return {
      account: accountId,
      ready: Boolean(live?.ready),
      phase: live?.phase || 'unknown',
      connectionState: live?.connectionState ?? null,
      pid: live?.pid ?? null,
      backend: 'up',
    };
  } catch (error) {
    return {
      account: accountId,
      ready: false,
      phase: 'offline',
      connectionState: null,
      pid: null,
      backend: 'down',
      error: error.message,
    };
  }
}

function proxyToAccount(accountId, req, res) {
  const port = resolveInternalHttpPort(accountId);
  const url = new URL(req.originalUrl, `http://127.0.0.1:${port}`);
  // Strip account query so upstream handlers stay simple.
  url.searchParams.delete('account');

  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  delete headers['x-whatseal-account'];
  delete headers['x-account'];

  const upstream = http.request(
    {
      protocol: 'http:',
      hostname: '127.0.0.1',
      port,
      path: `${url.pathname}${url.search}`,
      method: req.method,
      headers,
      timeout: 60000,
    },
    (upstreamRes) => {
      res.status(upstreamRes.statusCode || 502);
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined) res.setHeader(key, value);
      }
      // Ensure browser can call the single public origin.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Whatseal-Account, X-Account');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      upstreamRes.pipe(res);
    },
  );

  upstream.on('timeout', () => {
    upstream.destroy(new Error('Upstream account API timed out.'));
  });
  upstream.on('error', (error) => {
    if (!res.headersSent) {
      res.status(502).json({
        ok: false,
        error: `Account ${accountId} API unavailable on internal port ${port}: ${error.message}`,
        account: accountId,
        code: 'ACCOUNT_BACKEND_UNAVAILABLE',
      });
    } else {
      res.end();
    }
  });

  if (req.method === 'GET' || req.method === 'HEAD') {
    upstream.end();
    return;
  }
  req.pipe(upstream);
}

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Whatseal-Account, X-Account');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// List accounts for the switcher (does not expose internal ports to the UI).
app.get('/api/accounts', async (req, res) => {
  try {
    const config = await loadAccountsConfig();
    const selected = resolveAccountId(req, config);
    const entries = await Promise.all(
      config.accounts.map(async (entry) => {
        const status = await backendStatus(entry.id);
        return {
          id: entry.id,
          alias: entry.alias || entry.id,
          description: entry.description || '',
          default: entry.id === config.default,
          selected: entry.id === selected,
          ready: status.ready,
          phase: status.phase,
          connectionState: status.connectionState,
          backend: status.backend,
        };
      }),
    );
    res.json({
      ok: true,
      result: {
        default: config.default,
        selected,
        accounts: entries,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Everything else under /api/* is proxied to the selected account daemon.
app.use('/api', async (req, res) => {
  try {
    const config = await loadAccountsConfig();
    const accountId = resolveAccountId(req, config);
    res.setHeader('X-Whatseal-Account', accountId);
    proxyToAccount(accountId, req, res);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// User always uses :3000. Optional CRA dev server is hidden behind this gateway.
// WHATSEAL_WEB_DEV_PROXY=http://127.0.0.1:3010  → proxy SPA/HMR there.
// Otherwise serve web/build if present.
const devProxy = (process.env.WHATSEAL_WEB_DEV_PROXY || '').replace(/\/$/, '');
const staticDir = process.env.WHATSEAL_WEB_STATIC
  || path.join(sourceRoot, 'web', 'build');

function proxyToDev(req, res) {
  const target = new URL(devProxy);
  const headers = { ...req.headers, host: target.host };
  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: req.originalUrl,
      method: req.method,
      headers,
      timeout: 60000,
    },
    (upstreamRes) => {
      res.status(upstreamRes.statusCode || 502);
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined) res.setHeader(key, value);
      }
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    if (!res.headersSent) {
      res.status(502).type('text').send(
        `whatseal gateway is up on :${PUBLIC_PORT}, but the React dev server is not reachable at ${devProxy} (${error.message}).\n`
        + 'Start it with: npm run web:ui\n',
      );
    } else {
      res.end();
    }
  });
  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  if (devProxy) return proxyToDev(req, res);
  return next();
});

if (!devProxy) {
  app.use(express.static(staticDir, { index: false }));
  app.get('*', async (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    try {
      await readFile(path.join(staticDir, 'index.html'));
      res.sendFile(path.join(staticDir, 'index.html'));
    } catch {
      res.status(404).type('text').send(
        'whatseal web gateway is running on http://127.0.0.1:3000\n'
        + 'For UI: npm run web:ui (dev) or npm run web:build (static).\n'
        + 'Account switch is in the web menu — no multi-port needed.\n',
      );
    }
  });
}

const server = app.listen(PUBLIC_PORT, '127.0.0.1', () => {
  log.info('web-gateway-ready', `url=http://127.0.0.1:${PUBLIC_PORT} (single public port; account switch via header/query)`);
});

server.on('error', (error) => {
  log.error('web-gateway-failed', error.message);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info('web-gateway-stop', signal);
    server.close(() => process.exit(0));
  });
}
