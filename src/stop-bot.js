import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultInstanceDirectory, readInstanceRecord, requestInstanceControl } from './single-instance.js';

export async function stopBot({ directory = defaultInstanceDirectory, timeoutMs = 12000 } = {}) {
  const record = readInstanceRecord(directory);
  if (!record) return { code: 2, message: 'Malay TTS Bot is not running.' };
  const deadline = Date.now() + timeoutMs;
  try { await requestInstanceControl(record, { directory, action: 'stop', timeoutMs: Math.min(1500, timeoutMs) }); }
  catch (error) {
    if (['ECONNREFUSED', 'INSTANCE_CHANGED'].includes(error.code)) return { code: 2, message: 'The recorded bot instance is no longer running. No other process was stopped.' };
    return { code: 1, message: `Could not contact the bot safely (${error.code || 'control error'}).` };
  }
  while (Date.now() < deadline) {
    try { await requestInstanceControl(record, { directory, timeoutMs: Math.min(1500, Math.max(1, deadline - Date.now())) }); }
    catch (error) {
      if (['ECONNREFUSED', 'ECONNRESET', 'INSTANCE_CHANGED'].includes(error.code)) return { code: 0, message: 'Malay TTS Bot stopped cleanly.' };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { code: 1, message: 'Timed out waiting for this bot instance to stop. Check bot.log.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await stopBot();
  console[result.code === 1 ? 'error' : 'log'](result.message);
  process.exitCode = result.code;
}
