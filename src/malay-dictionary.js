import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from './config.js';

export const malayDictionaryPath = path.join(rootDir, 'config', 'dictionary-ms.json');

const WORD_CHAR_CLASS = '[\\p{L}\\p{N}_]';
const WATCH_INTERVAL_MS = 300;
const RELOAD_DEBOUNCE_MS = 200;

let dictionary = Object.create(null);
let dictionaryPattern = null;
let lastLoadedText = null;
let reloadTimer;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDictionary(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('dictionary-ms.json must contain a JSON object.');
  }

  const normalized = Object.create(null);
  for (const [rawKey, rawValue] of Object.entries(parsed)) {
    if (typeof rawValue !== 'string') {
      throw new TypeError(`Malay dictionary value for "${rawKey}" must be a string.`);
    }
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (!key || !value) continue;
    normalized[key] = value;
  }
  return normalized;
}

function applyDictionary(nextDictionary, rawText = null) {
  const keys = Object.keys(nextDictionary).sort(
    (a, b) => b.length - a.length || a.localeCompare(b, 'ms')
  );
  dictionary = nextDictionary;
  dictionaryPattern = keys.length > 0
    ? new RegExp(
      `(?<!${WORD_CHAR_CLASS})(?:${keys.map(escapeRegex).join('|')})(?!${WORD_CHAR_CLASS})`,
      'giu'
    )
    : null;
  if (rawText !== null) lastLoadedText = rawText;
}

export function loadMalayDictionary() {
  try {
    const rawText = fs.readFileSync(malayDictionaryPath, 'utf8');
    if (rawText === lastLoadedText) return false;
    applyDictionary(normalizeDictionary(JSON.parse(rawText)), rawText);
    console.log(`[dictionary-ms] Loaded ${Object.keys(dictionary).length} context-scoped Malay aliases.`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (!lastLoadedText) applyDictionary(Object.create(null), '');
      return false;
    }
    console.error('[dictionary-ms] Reload ignored; keeping previous map:', error.message);
    return false;
  }
}

function isAllCapsToken(value) {
  const letters = String(value).replace(/[^A-Za-z]/g, '');
  return letters.length >= 2 && letters === letters.toUpperCase();
}

export function replaceMalayDictionaryWords(text) {
  if (!dictionaryPattern || !text) return text;
  return text.replace(dictionaryPattern, (matched, offset, source) => {
    // Avoid turning real uppercase acronyms/brands such as AP, LG, NT or LA
    // into Malay chat shorthand merely because matching is case-insensitive.
    if (isAllCapsToken(matched)) return matched;

    const key = matched.toLowerCase();
    // In gaming chat, "tp to boss" means teleport, not Malay "tapi".
    if (key === 'tp' && /^\s+to\b/iu.test(source.slice(offset + matched.length))) return matched;

    return dictionary[key] ?? matched;
  });
}

export function getMalayDictionarySize() {
  return Object.keys(dictionary).length;
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => loadMalayDictionary(), RELOAD_DEBOUNCE_MS);
  reloadTimer.unref?.();
}

loadMalayDictionary();

fs.watchFile(
  malayDictionaryPath,
  { interval: WATCH_INTERVAL_MS, persistent: false },
  (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
    scheduleReload();
  }
);

export function replaceTrailingMalayParticles(text) {
  if (!text) return text;
  // Guild usage shows lowercase "ka" overwhelmingly as the Malay question
  // particle. Keep uppercase KA untouched for acronyms/names.
  return text.replace(/\bka(?=\s*[?!.…]*$)/u, 'ke');
}
