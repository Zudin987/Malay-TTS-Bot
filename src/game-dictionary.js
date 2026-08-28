import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from './config.js';

export const gameDictionaryPath = path.join(rootDir, 'config', 'dictionary-game.json');

const WORD_CHAR_CLASS = '[\\p{L}\\p{N}_]';
const WATCH_INTERVAL_MS = 300;
const RELOAD_DEBOUNCE_MS = 200;
const GAME_CONTEXT_PATTERN = /\b(?:raid|boss|tank|heal(?:er|ing)?|gear|damage|skill|dungeon|mech|buff|debuff|cooldown|level|season|party|queue|crit|attack|shield|mage|melee|range|farm|dps|pvp|pve|guild|class|weapon|module|talent|stat|lifewave|mastery|helmet|build|far\s+sea|stimen|vault)\b/iu;
const SELF_CONTEXT_SAFE = new Set(['sk', 'gh', 'gs', 'sv', 'nm', 'dg', 'dmg', 'mf']);
const ALWAYS_EXPAND = new Set(['sv', 'sv30', 'dmg', 'dg', 'mf']);

let dictionary = Object.create(null);
let dictionaryPattern = null;
let lastLoadedText = null;
let reloadTimer;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDictionary(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('dictionary-game.json must contain a JSON object.');
  }
  const normalized = Object.create(null);
  for (const [rawKey, rawValue] of Object.entries(parsed)) {
    if (typeof rawValue !== 'string') throw new TypeError(`Game dictionary value for "${rawKey}" must be a string.`);
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (key && value) normalized[key] = value;
  }
  return normalized;
}

function applyDictionary(nextDictionary, rawText = null) {
  const keys = Object.keys(nextDictionary).sort((a, b) => b.length - a.length || a.localeCompare(b, 'en'));
  dictionary = nextDictionary;
  dictionaryPattern = keys.length
    ? new RegExp(`(?<!${WORD_CHAR_CLASS})(?:${keys.map(escapeRegex).join('|')})(?!${WORD_CHAR_CLASS})`, 'giu')
    : null;
  if (rawText !== null) lastLoadedText = rawText;
}

export function loadGameDictionary() {
  try {
    const rawText = fs.readFileSync(gameDictionaryPath, 'utf8');
    if (rawText === lastLoadedText) return false;
    applyDictionary(normalizeDictionary(JSON.parse(rawText)), rawText);
    console.log(`[dictionary-game] Loaded ${Object.keys(dictionary).length} context-scoped game aliases.`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (!lastLoadedText) applyDictionary(Object.create(null), '');
      return false;
    }
    console.error('[dictionary-game] Reload ignored; keeping previous map:', error.message);
    return false;
  }
}

function isAllCapsToken(value) {
  const letters = String(value).replace(/[^A-Za-z]/g, '');
  return letters.length >= 2 && letters === letters.toUpperCase();
}

export function replaceGameDictionaryWords(text, { allowMalayContext = false } = {}) {
  if (!dictionaryPattern || !text) return text;
  const hasGameContext = GAME_CONTEXT_PATTERN.test(text);
  GAME_CONTEXT_PATTERN.lastIndex = 0;

  return text.replace(dictionaryPattern, (matched) => {
    const key = matched.toLowerCase();
    const selfContext = isAllCapsToken(matched) && SELF_CONTEXT_SAFE.has(key);
    if (!ALWAYS_EXPAND.has(key) && !allowMalayContext && !hasGameContext && !selfContext) return matched;
    return dictionary[key] ?? matched;
  });
}

export function getGameDictionarySize() {
  return Object.keys(dictionary).length;
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadGameDictionary, RELOAD_DEBOUNCE_MS);
  reloadTimer.unref?.();
}

loadGameDictionary();
fs.watchFile(gameDictionaryPath, { interval: WATCH_INTERVAL_MS, persistent: false }, (current, previous) => {
  if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
  scheduleReload();
});
