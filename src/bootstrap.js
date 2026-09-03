import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fatalLogSync, flushLogs, installLogger } from './logger.js';
import { acquireSingleInstanceLock, defaultInstanceDirectory } from './single-instance.js';
import { getGeminiApiKeyRoundRobinStatus } from './gemini-key-config.js';
import { terminateAllChildren } from './child-processes.js';

export async function startBot({ directory = defaultInstanceDirectory, loadApp = () => import('./index.js'), startupTimeoutMs = 45000 } = {}) {
  let app = null;
  let stopping = false;
  let startupTimer;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(startupTimer);
    if (app) return app.gracefulShutdown('local stop control');
    // This path is installed before importing index.js / awaiting Discord login.
    // A requested stop must stay stopped; a nonzero exit would trigger Scheduler restart.
    const deadline = setTimeout(() => process.exit(0), 5000);
    await terminateAllChildren();
    await flushLogs();
    clearTimeout(deadline);
    process.exit(0);
  };
  const lease = await acquireSingleInstanceLock({ directory, onStopRequested: stop });
  if (!lease) {
    console.warn('Another process owns this bot installation’s local control endpoint. This instance will exit.');
    return false;
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  startupTimer = setTimeout(() => {
    fatalLogSync('[fatal-startup]', 'Discord startup did not finish within its deadline.');
    process.exit(1);
  }, startupTimeoutMs);
  try { app = await loadApp(); }
  finally { clearTimeout(startupTimer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  if (stopping) await app.gracefulShutdown('stop during startup');
  return lease;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  installLogger();
  try {
    const keys = getGeminiApiKeyRoundRobinStatus();
    console.log(`[gemini-keys] ${keys.configuredCount} unique keys configured; round-robin slots ${keys.configuredSlots.join(', ') || 'none'}; first slot ${keys.startSlot ?? 'none'}.`);
    await startBot();
  } catch (error) {
    fatalLogSync('[fatal-startup]', error instanceof Error ? error : new Error(String(error)));
    process.exit(1);
  }
}
