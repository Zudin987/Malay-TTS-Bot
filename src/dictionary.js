import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from './config.js';
import { writeBackupText } from './safe-json.js';
import { isReservedAcronymKey } from './acronyms.js';
import { getGuildDictionaryOverrides, setGuildDictionaryEntry, removeGuildDictionaryEntry } from './store.js';

export const dictionaryPath = path.join(rootDir, 'config', 'dictionary.json');
const dictionaryBackupPath = `${dictionaryPath}.bak`;
const WORD_CHAR_CLASS = '[\\p{L}\\p{N}_]';
const WATCH_INTERVAL_MS = 300;
const RELOAD_DEBOUNCE_MS = 200;

let dictionary = Object.create(null);
let dictionaryPattern = null;
let dictionaryVersion = 0;
let lastLoadedText = null;
let reloadTimer;
const mergedDictionaryCache = new Map();

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDictionary(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('dictionary.json must contain a JSON object.');
  }
  const normalized = Object.create(null);
  for (const [rawKey, rawValue] of Object.entries(parsed)) {
    if (typeof rawValue !== 'string') throw new TypeError(`Dictionary value for "${rawKey}" must be a string.`);
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (key && value) normalized[key] = value;
  }
  return normalized;
}

function compilePattern(entries) {
  const keys = Object.keys(entries).sort((a, b) => b.length - a.length || a.localeCompare(b, 'ms'));
  return keys.length > 0
    ? new RegExp(`(?<!${WORD_CHAR_CLASS})(?:${keys.map(escapeRegex).join('|')})(?!${WORD_CHAR_CLASS})`, 'giu')
    : null;
}

function applyDictionary(nextDictionary, rawText = null) {
  dictionary = nextDictionary;
  dictionaryPattern = compilePattern(nextDictionary);
  dictionaryVersion += 1;
  mergedDictionaryCache.clear();
  if (rawText !== null) lastLoadedText = rawText;
}

function loadBackupDictionary() {
  try {
    const rawText = fs.readFileSync(dictionaryBackupPath, 'utf8');
    const normalized = normalizeDictionary(JSON.parse(rawText));
    applyDictionary(normalized, rawText);
    console.warn(`[dictionary] Recovered ${Object.keys(dictionary).length} entries from dictionary.json.bak.`);
    return true;
  } catch {
    return false;
  }
}

export function loadDictionary() {
  try {
    const rawText = fs.readFileSync(dictionaryPath, 'utf8');
    if (rawText === lastLoadedText) return false;
    const normalized = normalizeDictionary(JSON.parse(rawText));
    if (lastLoadedText && lastLoadedText !== rawText) {
      // The shipped dictionary is immutable during normal bot use. Only create
      // a backup when a user manually changes the file after a valid load.
      try { writeBackupText(dictionaryBackupPath, lastLoadedText); } catch (error) {
        console.warn('[dictionary] Could not update backup:', error.message);
      }
    }
    applyDictionary(normalized, rawText);
    console.log(`[dictionary] Loaded ${Object.keys(dictionary).length} shipped entries.`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' && !lastLoadedText && loadBackupDictionary()) return true;
    if (!lastLoadedText && loadBackupDictionary()) return true;
    if (error.code !== 'ENOENT') console.error('[dictionary] Reload ignored; keeping previous dictionary:', error.message);
    return false;
  }
}

function mergedDictionary(guildId) {
  if (!guildId) return { entries: dictionary, pattern: dictionaryPattern };

  const id = String(guildId);
  const overrides = getGuildDictionaryOverrides(id);
  if (Object.keys(overrides).length === 0) {
    mergedDictionaryCache.delete(id);
    return { entries: dictionary, pattern: dictionaryPattern };
  }

  const signature = JSON.stringify(overrides);
  const cached = mergedDictionaryCache.get(id);
  if (cached?.dictionaryVersion === dictionaryVersion && cached.signature === signature) return cached.value;

  const entries = { ...dictionary, ...overrides };
  const value = { entries, pattern: compilePattern(entries) };
  if (!mergedDictionaryCache.has(id) && mergedDictionaryCache.size >= 256) mergedDictionaryCache.delete(mergedDictionaryCache.keys().next().value);
  mergedDictionaryCache.set(id, { dictionaryVersion, signature, value });
  return value;
}

export function invalidateGuildDictionaryCache(guildId) {
  if (guildId != null) mergedDictionaryCache.delete(String(guildId));
}

export function addDictionaryEntry(guildId, shortform, expanded) {
  const result = setGuildDictionaryEntry(guildId, shortform, expanded);
  invalidateGuildDictionaryCache(guildId);
  return result;
}

export function removeDictionaryEntry(guildId, shortform) {
  const result = removeGuildDictionaryEntry(guildId, shortform);
  invalidateGuildDictionaryCache(guildId);
  return result;
}

export function replaceDictionaryWords(text, guildId = null) {
  if (!text) return text;
  const { entries, pattern } = mergedDictionary(guildId);
  if (!pattern) return text;

  return text.replace(pattern, (matched) => {
    if (isReservedAcronymKey(matched)) return matched;
    const key = matched.toLowerCase();
    if (key === 'la' && matched === 'LA') return matched;
    return entries[key] ?? matched;
  });
}

export function getDictionarySize(guildId = null) {
  if (!guildId) return Object.keys(dictionary).length;
  return Object.keys({ ...dictionary, ...getGuildDictionaryOverrides(guildId) }).length;
}

export function getCustomDictionarySize(guildId) {
  return Object.keys(getGuildDictionaryOverrides(guildId)).length;
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => loadDictionary(), RELOAD_DEBOUNCE_MS);
  reloadTimer.unref?.();
}

loadDictionary();
fs.watchFile(dictionaryPath, { interval: WATCH_INTERVAL_MS, persistent: false }, (current, previous) => {
  if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
  scheduleReload();
});

export const __test = {
  normalizeDictionary,
  compilePattern,
  getMergedCacheSize: () => mergedDictionaryCache.size,
  getDictionaryVersion: () => dictionaryVersion
};
