import express from 'express';
import { assertLocalMode } from './local-mode.js';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drainBackgroundTaskQueues } from './background-task-queue.js';
import { startServerDataBackupSchedule } from './data-backup.js';
import { trustProxySetting } from './request-context.js';
import { DATA_DIR, drainStoreWrites, ensureStore, readStore, ROOT_CREDENTIALS_FILE } from './store.js';
import { closeSqliteDatabases, sqlitePrimaryMode, sqliteFilePath } from './storage/sqlite.js';
import { publicOrigin as validatedPublicOrigin } from './v2/identity/providers.js';
import { assertNotificationOrigin } from './v2/notification-platforms/runtime-mode.js';
import { setStaticCacheHeaders } from './static-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 8787);
const bindHost = process.env.NB_BIND_HOST || '127.0.0.1';
const configuredShutdownGraceMs = Number(process.env.NB_SHUTDOWN_GRACE_MS || 30_000);
const shutdownGraceMs = Number.isFinite(configuredShutdownGraceMs) && configuredShutdownGraceMs >= 1_000
  ? configuredShutdownGraceMs
  : 30_000;
let draining = false;
let shutdownPromise = null;
let startupPromise, apiRouter, composition, productionLease, dataBackupSchedule, stopBackgroundJobs, relayWebSocket;
const productionV2 = process.env.NB_V2_PRODUCTION_ENABLED === '1';
const localMode = assertLocalMode();
if (localMode && !productionV2) throw new Error('LOCAL_V2_REQUIRED');

function waitForShutdownStep(promise, step, deadlineAtMs) {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(Object.assign(new Error(`shutdown deadline exceeded before ${step}`), {
      code: 'SHUTDOWN_DEADLINE_EXCEEDED',
      step
    }));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(
      new Error(`shutdown deadline exceeded while waiting for ${step}`),
      { code: 'SHUTDOWN_DEADLINE_EXCEEDED', step }
    )), remainingMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

app.disable('x-powered-by');
const trustProxy = trustProxySetting();
if (trustProxy) app.set('trust proxy', trustProxy);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  // Keep framing protection when the app is reached without the production proxy.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
  next();
});
app.use((req, res, next) => {
  if (!draining) return next();
  res.setHeader('Connection', 'close');
  return res.status(503).json({
    ok: false,
    service: 'nb-clan-member-system',
    time: new Date().toISOString(),
    shuttingDown: true
  });
});

app.get('/api/workspace-entry', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ defaultWorkspace: productionV2 ? 'v2' : 'legacy' });
});
// The root URL must use the same activated workspace as the API owners.
app.get(['/', '/index.html'], (req, res, next) => {
  if (!productionV2) return next();
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(303, new URL(req.originalUrl, 'http://localhost').searchParams.get('login') === '1' ? '/login' : '/app/home');
});
// Mount the original router at this position after startup composition. The
// legacy faces continue through their existing, domain-specific compatibility gates.
app.use('/api', (req, res, next) => {
  if (localMode && (/^\/(?:v2\/)?auth\/(?:steam|discord|kook)(?:\/|$)/.test(req.path) || /^\/(?:integrations|wechat)(?:\/|$)/.test(req.path))) {
    req.resume();
    return res.status(403).json({ error: { errorCode: 'LOCAL_EXTERNAL_INTEGRATION_DISABLED' } });
  }
  next();
});
app.use('/api', (req, res, next) => apiRouter ? apiRouter(req, res, next) : res.sendStatus(503));
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads'), {
  setHeaders(res, filePath) {
    if (filePath.includes(`${path.sep}map-files${path.sep}`) && path.extname(filePath).toLowerCase() === '.map') {
      res.setHeader('Content-Disposition', 'attachment');
    }
  }
}));

const distDir = path.resolve(__dirname, '..', 'dist');
// Existing KOOK cards link to the image URL. Open a scrollable guide instead
// of the browser's image viewer, which shrinks the tall image to screen height.
app.get('/guides/kook-steam-binding.png', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.redirect(302, '/guides/kook-steam-binding.html');
});
app.use(express.static(distDir, {
  setHeaders(res, filePath) {
    const relativePath = path.relative(distDir, filePath).split(path.sep).join('/');
    setStaticCacheHeaders(res, relativePath, res.req.originalUrl);
  }
}));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile('index.html', { root: distDir });
});

const server = createServer(app);
const sockets = new Set();
server.on('connection', (socket) => {
  if (draining) {
    socket.destroy();
    return;
  }
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
server.on('close', () => {
  dataBackupSchedule?.stop();
});

async function shutdown(signal, { startupFailed = false } = {}) {
  draining = true;
  const shutdownDeadlineAtMs = Date.now() + shutdownGraceMs;
  stopBackgroundJobs?.();
  dataBackupSchedule?.stop();
  console.log(`[nb-clan] ${signal} received; draining connections for up to ${shutdownGraceMs}ms`);

  let forced = false;
  const forceTimer = setTimeout(() => {
    forced = true;
    server.closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
  }, shutdownGraceMs);
  forceTimer.unref?.();

  let exitCode = startupFailed ? 1 : 0;
  try {
    // Startup can be interrupted before listen. Let its current operation settle
    // before closing resources it may still be constructing.
    await waitForShutdownStep(startupPromise?.catch(() => {}), 'startup settlement', shutdownDeadlineAtMs);
    stopBackgroundJobs?.();
    dataBackupSchedule?.stop();
    const owners = Promise.allSettled([relayWebSocket?.drain(), apiRouter?.v2Runtime.stop(), composition?.stop()]).then(results => {
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'V2 production owners did not drain');
    });
    await waitForShutdownStep(Promise.all([
      owners,
      new Promise((resolve, reject) => {
        server.close((error) => (error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
        server.closeIdleConnections?.();
      })
    ]), 'V2 runtime and http connections', shutdownDeadlineAtMs);
    const remainingQueueDrainMs = Math.max(1, shutdownDeadlineAtMs - Date.now());
    await waitForShutdownStep(Promise.all([
      dataBackupSchedule?.drain?.() || Promise.resolve(),
      drainBackgroundTaskQueues({ timeoutMs: remainingQueueDrainMs, stopAccepting: true })
    ]), 'background tasks and backup', shutdownDeadlineAtMs);
    await waitForShutdownStep(drainStoreWrites(), 'store writes', shutdownDeadlineAtMs);
    await waitForShutdownStep(
      closeSqliteDatabases({ checkpointMode: 'TRUNCATE' }),
      'sqlite close',
      shutdownDeadlineAtMs
    );
    // Retain the fence on every failed drain; another process must never take
    // over a database while an old owner could still be writing.
    await waitForShutdownStep(productionLease?.release(), 'production lease release', shutdownDeadlineAtMs);
  } catch (error) {
    exitCode = 1;
    console.error('[nb-clan] graceful shutdown failed:', error?.stack || error);
  } finally {
    clearTimeout(forceTimer);
  }

  console.log(`[nb-clan] shutdown complete${forced ? ' after forcing remaining connections closed' : ''}`);
  process.exit(exitCode);
}

function beginShutdown(signal) {
  if (shutdownPromise) {
    server.closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
    return;
  }
  draining = true;
  shutdownPromise = shutdown(signal).catch((error) => {
    console.error('[nb-clan] shutdown handler failed:', error?.stack || error);
    process.exit(1);
  });
}

process.once('SIGTERM', () => beginShutdown('SIGTERM'));
process.once('SIGINT', () => beginShutdown('SIGINT'));

async function start() {
  if (productionV2) {
    if (process.env.NB_V2_IDENTITY_ENABLED !== '1' || !sqlitePrimaryMode()) {
      throw new Error('PRODUCTION_IDENTITY_AND_SQLITE_REQUIRED');
    }
    const publicOrigin = validatedPublicOrigin(process.env.NB_V2_PUBLIC_ORIGIN || process.env.NB_PUBLIC_BASE_URL);
    assertNotificationOrigin(publicOrigin, localMode ? 'isolated' : 'production');
    process.env.NB_V2_PUBLIC_ORIGIN = publicOrigin;
    // These legacy schedulers read their configuration during api.js evaluation.
    process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
    process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';
    const config = { dataDirectory: DATA_DIR, databaseFile: sqliteFilePath() };
    const { acquireProductionLease, validateProductionReady } = await import('./v2/production/migrations.js');
    productionLease = await acquireProductionLease(config, { mode: 'runtime' });
    await validateProductionReady(config);
    const { createProductionComposition } = await import('./v2/production/runtime.js');
    composition = createProductionComposition({ ...config, publicOrigin, env: process.env });
    if (typeof composition.ingestRelay !== 'function') throw new Error('PRODUCTION_RELAY_OWNER_REQUIRED');
  }
  await ensureStore();
  await readStore();
  const api = await import('./api.js');
  stopBackgroundJobs = api.stopBackgroundJobs;
  apiRouter = api.createApiRouter(composition ? { ...composition.factories, relayIngest: composition.ingestRelay } : undefined);
  await composition?.start(apiRouter);
  if (draining) throw new Error('STARTUP_INTERRUPTED');
  dataBackupSchedule = startServerDataBackupSchedule();
  const { installRustplusRelayWebSocket } = await import('./rustplus-relay-stream.js');
  relayWebSocket = installRustplusRelayWebSocket(server, productionV2 ? {
    relayIngest: composition.ingestRelay, authenticateRelay: apiRouter.v2Runtime.authenticateRelay
  } : { onRelayPayload: api.forwardRustplusRelayChatToDiscord });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindHost, () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : port;
  console.log(`NB Clan API listening on http://${bindHost}:${listeningPort}`);
  console.log(`Root credentials: ${ROOT_CREDENTIALS_FILE}`);
}

startupPromise = start();
try { await startupPromise; }
catch (error) {
  console.error('[nb-clan] startup failed:', error?.stack || error);
  shutdownPromise ||= shutdown('startup failure', { startupFailed: true });
  await shutdownPromise;
}
