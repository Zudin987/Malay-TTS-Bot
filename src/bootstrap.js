import 'dotenv/config';
import { fatalLogSync, installLogger } from './logger.js';
import { acquireSingleInstanceLock } from './single-instance.js';
import { startStopRequestWatcher } from './stop-control.js';
import { applyGeminiApiKeySelection } from './gemini-key-config.js';

installLogger();

try {
  const keySelection = applyGeminiApiKeySelection(process.env);
  if (keySelection.configuredCount > 1) {
    console.log(`[gemini-keys] ${keySelection.configuredCount} keys configured; active slot ${keySelection.selectedSlot ?? 'none'}. Manual slot selection only; quota/rate-limit errors do not rotate keys.`);
  } else if (keySelection.configuredCount === 1 && keySelection.selectedSlot !== keySelection.requestedSlot) {
    console.warn(`[gemini-keys] Requested slot ${keySelection.requestedSlot} is empty; using configured slot ${keySelection.selectedSlot}.`);
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
