import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
export const acronymsPath = path.join(rootDir, 'config', 'acronyms.json');

const WORD_CHAR_CLASS = '[\\p{L}\\p{N}_]';
const WATCH_INTERVAL_MS = 300;
const RELOAD_DEBOUNCE_MS = 200;

// Built-in exact technical protection that should work even when an existing
// user's acronyms.json is preserved by a drop-in update. Lowercase `apo` remains
// available as Malay chat shorthand in the Malay-scoped dictionary.
const BUILTIN_EXACT_ACRONYMS = Object.freeze({ APO: 'A P O' });

let acronyms = Object.create(null);
let acronymPattern = null;
let lowercaseKeys = new Set();
let lastLoadedText = null;
let reloadTimer;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAcronyms(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('acronyms.json must contain a JSON object.');
  }

  const normalized = Object.create(null);
  for (const [rawKey, rawValue] of Object.entries(parsed)) {
    if (typeof rawValue !== 'string') throw new TypeError(`Acronym value for "${rawKey}" must be a string.`);
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) continue;
    normalized[key] = value;
  }
  return normalized;
}

function applyAcronyms(next, rawText = null) {
  const keys = Object.keys(next).sort((a, b) => b.length - a.length || a.localeCompare(b, 'en'));
  acronyms = next;
  lowercaseKeys = new Set(keys.map((key) => key.toLocaleLowerCase('en-US')));
  acronymPattern = keys.length
    ? new RegExp(`(?<!${WORD_CHAR_CLASS})(?:${keys.map(escapeRegex).join('|')})(?!${WORD_CHAR_CLASS})`, 'gu')
    : null;
  if (rawText !== null) lastLoadedText = rawText;
}

export function loadAcronyms() {
  try {
    const rawText = fs.readFileSync(acronymsPath, 'utf8');
    if (rawText === lastLoadedText) return false;
    const normalized = normalizeAcronyms(JSON.parse(rawText));
    applyAcronyms(normalized, rawText);
    console.log(`[acronyms] Loaded ${Object.keys(acronyms).length} exact-case entries.`);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (!lastLoadedText) applyAcronyms(Object.create(null));
      return false;
    }
    console.error('[acronyms] Reload ignored; keeping previous acronyms:', error.message);
    return false;
  }
}

export function replaceExactAcronyms(text) {
  if (!text) return text;
  let result = acronymPattern
    ? text.replace(acronymPattern, (matched) => acronyms[matched] ?? matched)
    : text;

  for (const [key, value] of Object.entries(BUILTIN_EXACT_ACRONYMS)) {
    if (Object.hasOwn(acronyms, key)) continue;
    const escaped = escapeRegex(key);
    result = result.replace(
      new RegExp(`(?<!${WORD_CHAR_CLASS})${escaped}(?!${WORD_CHAR_CLASS})`, 'gu'),
      value
    );
  }
  return result;
}

// If a key exists in acronyms.json, the ordinary case-insensitive dictionary
// must leave all case variants alone. This is what makes `RAM` pronounce as
// letters while lowercase `ram` can stay an ordinary word.
export function isReservedAcronymKey(value) {
  return lowercaseKeys.has(String(value).toLocaleLowerCase('en-US'));
}

export function getAcronymSize() {
  const keys = new Set([...Object.keys(BUILTIN_EXACT_ACRONYMS), ...Object.keys(acronyms)]);
  return keys.size;
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadAcronyms, RELOAD_DEBOUNCE_MS);
  reloadTimer.unref?.();
}

loadAcronyms();
fs.watchFile(acronymsPath, { interval: WATCH_INTERVAL_MS, persistent: false }, (current, previous) => {
  if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
  scheduleReload();
});
