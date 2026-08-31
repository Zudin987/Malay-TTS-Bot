import 'dotenv/config';
import { fatalLogSync, installLogger } from './logger.js';
import { acquireSingleInstanceLock } from './single-instance.js';
import { startStopRequestWatcher } from './stop-control.js';
import { getGeminiApiKeyRoundRobinStatus } from './gemini-key-config.js';

installLogger();

try {
  const keyStatus = getGeminiApiKeyRoundRobinStatus();
  if (keyStatus.configuredCount > 1) {
    console.log(`[gemini-keys] ${keyStatus.configuredCount} keys configured; round-robin enabled across slots ${keyStatus.configuredSlots.join(', ')}; first slot ${keyStatus.startSlot ?? 'none'}.`);
  } else if (keyStatus.configuredCount === 1) {
    console.log(`[gemini-keys] One Gemini key configured in slot ${keyStatus.startSlot}; round-robin behaves as single-key mode.`);
  }

  if (!acquireSingleInstanceLock()) {
    console.warn('Bot is already running. This second instance will exit.');
    process.exit(0);
  }

  const app = await import('./index.js');
  startStopRequestWatcher(() => app.gracefulShutdown('stop-bot.vbs'));
} catch (error) {
  // start-hidden.vbs / Task Scheduler may have no visible console, so startup
  // failures must land synchronously before the non-zero exit.
  fatalLogSync('[fatal-startup]', error instanceof Error ? error : new Error(String(error)));
  process.exit(1);
}
