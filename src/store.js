import fs from 'node:fs';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { dataDir, settings } from './config.js';
import { readJsonWithBackup, writeBackupText, writeJsonAtomicWithBackup } from './safe-json.js';
import { cancelAllSpeakerLabelGeneration } from './speaker-label.js';

const filePath = path.join(dataDir, 'guilds.json');
let guilds = {};
let lastValidText = null;
let deferredSaveTimer = null;

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function cleanStringMap(value, { maxKey = 128, maxValue = 128, normalizeKey = null } = {}) {
  if (!isObject(value)) return {};
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== 'string') continue;
    const raw = String(rawKey).trim().slice(0, maxKey);
    const key = typeof normalizeKey === 'function' ? normalizeKey(raw) : raw;
    const mapped = rawValue.trim().slice(0, maxValue);
    if (key && mapped) output[key] = mapped;
  }
  return output;
}


function cleanIdList(value, maximum = 500) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item ?? '').trim())
    .filter((item) => /^\d{5,32}$/u.test(item)))]
    .slice(0, maximum);
}

function updateOptOutIds(currentIds, userId, enabled) {
  const key = String(userId ?? '').trim();
  const ids = new Set(cleanIdList(currentIds, Number.POSITIVE_INFINITY));
  if (enabled) ids.add(key);
  else ids.delete(key);
  return cleanIdList([...ids], Number.POSITIVE_INFINITY);
}

function normalizeGuild(raw = {}) {
  const input = isObject(raw) ? raw : {};
  return {
    speakerMode: ['cakap', 'username', 'none'].includes(input.speakerMode)
      ? input.speakerMode
      : settings.speakerMode,
    speakerResetSeconds: clampInt(input.speakerResetSeconds, settings.speakerResetSeconds, 5, 300),
    voiceLogEnabled: typeof input.voiceLogEnabled === 'boolean'
      ? input.voiceLogEnabled
      : Boolean(settings.voiceLogEnabled),
    voiceLogUserId: typeof input.voiceLogUserId === 'string' && input.voiceLogUserId.trim()
      ? input.voiceLogUserId.trim()
      : null,
    voiceLogChannelId: typeof input.voiceLogChannelId === 'string' && input.voiceLogChannelId.trim()
      ? input.voiceLogChannelId.trim()
      : null,
    userAliases: cleanStringMap(input.userAliases, { maxValue: 80 }),
    ttsVoices: cleanStringMap(input.ttsVoices, { maxValue: 40 }),
    // Privacy state must never be silently truncated. An arbitrary entry cap can
    // make /ttsoptout report success while dropping a later user's opt-out.
    ttsOptOutUserIds: cleanIdList(input.ttsOptOutUserIds, Number.POSITIVE_INFINITY),
    dictionaryOverrides: cleanStringMap(input.dictionaryOverrides, { maxKey: 80, maxValue: 160, normalizeKey: (key) => key.toLocaleLowerCase('ms-MY') })
  };
}

function normalizeGuildCollection(value) {
  if (!isObject(value)) return {};
  const output = {};
  for (const [guildId, rawGuild] of Object.entries(value)) {
    if (!/^\d{5,32}$/.test(String(guildId))) continue;
    output[guildId] = normalizeGuild(rawGuild);
  }
  return output;
}

function loadGuilds() {
  const loaded = readJsonWithBackup(filePath, {});
  guilds = normalizeGuildCollection(loaded.value);
  lastValidText = loaded.text;

  if (loaded.source === 'primary' && loaded.text) {
    try { writeBackupText(`${filePath}.bak`, loaded.text); } catch (error) {
      console.warn('[store] Could not refresh guilds.json.bak:', error.message);
    }
  }

  if (loaded.source === 'backup') {
    console.warn('[store] guilds.json was invalid; recovered from guilds.json.bak.');
    try {
      lastValidText = writeJsonAtomicWithBackup(filePath, guilds, loaded.text);
    } catch (error) {
      console.error('[store] Could not restore guilds.json from backup:', error.message);
    }
  } else if (loaded.source === 'fallback' && loaded.primaryError?.code !== 'ENOENT') {
    console.error('[store] guilds.json is invalid and no valid backup exists; starting empty.');
  }
}

loadGuilds();

function save() {
  if (deferredSaveTimer) { clearTimeout(deferredSaveTimer); deferredSaveTimer = null; }
  fs.mkdirSync(dataDir, { recursive: true });
  lastValidText = writeJsonAtomicWithBackup(filePath, guilds, lastValidText);
}

function scheduleNoncriticalSave(delayMs = 150) {
  if (deferredSaveTimer) return;
  deferredSaveTimer = setTimeout(() => {
    deferredSaveTimer = null;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      lastValidText = writeJsonAtomicWithBackup(filePath, guilds, lastValidText);
    } catch (error) {
      console.error('[store] Deferred guilds.json save failed:', error.message);
    }
  }, Math.max(25, Math.min(Number(delayMs) || 150, 1000)));
  deferredSaveTimer.unref?.();
}

export function getGuildSettings(guildId) {
  const id = String(guildId ?? '').trim();
  if (!id) throw new TypeError('guildId is required.');

  const normalized = normalizeGuild(guilds[id]);
  const previous = guilds[id];
  const changed = !isObject(previous) || JSON.stringify(previous) !== JSON.stringify(normalized);
  guilds[id] = normalized;
  if (changed) scheduleNoncriticalSave();
  return guilds[id];
}

export function updateGuildSettings(guildId, patch) {
  const current = getGuildSettings(guildId);
  guilds[guildId] = normalizeGuild({ ...current, ...(isObject(patch) ? patch : {}) });
  save();
  return guilds[guildId];
}

export function setUserAlias(guildId, userId, alias) {
  const current = getGuildSettings(guildId);
  const value = String(alias ?? '').trim().slice(0, 80);
  if (!value) throw new Error('Alias cannot be empty.');
  current.userAliases[String(userId)] = value;
  save();
}

export function removeUserAlias(guildId, userId) {
  const current = getGuildSettings(guildId);
  if (!(String(userId) in current.userAliases)) return false;
  delete current.userAliases[String(userId)];
  save();
  return true;
}

export function getUserAlias(guildId, userId) {
  return getGuildSettings(guildId).userAliases[String(userId)] ?? null;
}

export function getUserTtsVoice(guildId, userId) {
  return getGuildSettings(guildId).ttsVoices[String(userId)] ?? null;
}

export function setUserTtsVoice(guildId, userId, voice) {
  const current = getGuildSettings(guildId);
  const value = String(voice ?? '').trim().slice(0, 40);
  if (!value) throw new Error('Voice cannot be empty.');
  current.ttsVoices[String(userId)] = value;
  save();
  return value;
}

export function getOrAssignUserTtsVoice(guildId, userId, allowedVoices) {
  const voices = Array.isArray(allowedVoices)
    ? [...new Set(allowedVoices.map((voice) => String(voice).trim()).filter(Boolean))]
    : [];
  if (voices.length === 0) throw new Error('No TTS voices are configured.');

  const current = getGuildSettings(guildId);
  const key = String(userId);
  const existing = current.ttsVoices[key];
  if (voices.includes(existing)) return existing;

  const usage = new Map(voices.map((voice) => [voice, 0]));
  for (const assigned of Object.values(current.ttsVoices)) {
    if (usage.has(assigned)) usage.set(assigned, usage.get(assigned) + 1);
  }

  const minimumUsage = Math.min(...usage.values());
  const candidates = voices.filter((voice) => usage.get(voice) === minimumUsage);
  const selected = candidates[randomInt(candidates.length)];
  current.ttsVoices[key] = selected;
  scheduleNoncriticalSave();
  return selected;
}

export function getTtsVoiceAllocation(guildId, allowedVoices) {
  const voices = Array.isArray(allowedVoices)
    ? [...new Set(allowedVoices.map((voice) => String(voice).trim()).filter(Boolean))]
    : [];
  const current = getGuildSettings(guildId);
  const counts = Object.fromEntries(voices.map((voice) => [voice, 0]));
  let assignedUsers = 0;

  for (const assigned of Object.values(current.ttsVoices)) {
    if (!(assigned in counts)) continue;
    counts[assigned] += 1;
    assignedUsers += 1;
  }

  return {
    counts,
    assignedUsers,
    occupiedVoices: Object.values(counts).filter((count) => count > 0).length,
    totalVoices: voices.length
  };
}

export function isUserTtsOptedOut(guildId, userId) {
  return getGuildSettings(guildId).ttsOptOutUserIds.includes(String(userId));
}

export function setUserTtsOptOut(guildId, userId, enabled) {
  const current = getGuildSettings(guildId);
  current.ttsOptOutUserIds = updateOptOutIds(current.ttsOptOutUserIds, userId, enabled);
  save();
  // Speaker-label generation is an independent Google request. Abort any
  // currently active label work as soon as privacy opt-out becomes effective;
  // queued/current message audio is cancelled separately by audio.js.
  if (enabled) cancelAllSpeakerLabelGeneration(new Error('TTS privacy opt-out enabled.'));
  return enabled;
}

export function getGuildDictionaryOverrides(guildId) {
  return { ...getGuildSettings(guildId).dictionaryOverrides };
}

export function setGuildDictionaryEntry(guildId, shortform, expanded) {
  const key = String(shortform ?? '').trim().toLowerCase().slice(0, 80);
  const value = String(expanded ?? '').trim().slice(0, 160);
  if (!key || !value) throw new Error('Shortform and expansion cannot be empty.');
  const current = getGuildSettings(guildId);
  current.dictionaryOverrides[key] = value;
  save();
  return value;
}

export function removeGuildDictionaryEntry(guildId, shortform) {
  const key = String(shortform ?? '').trim().toLowerCase();
  const current = getGuildSettings(guildId);
  if (!Object.hasOwn(current.dictionaryOverrides, key)) return false;
  delete current.dictionaryOverrides[key];
  save();
  return true;
}

export const __test = { normalizeGuild, normalizeGuildCollection, updateOptOutIds };
