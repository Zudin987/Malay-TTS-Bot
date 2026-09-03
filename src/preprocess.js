import { settings } from './config.js';
import { replaceDictionaryWords } from './dictionary.js';
import { applyContextDictionaries } from './context-dictionary.js';
import { getUserAlias } from './store.js';
import { addIntonationCues } from './intonation.js';
import { stripTextEmoticons } from './text-emoticons.js';
import { stripSymbolNoise } from './text-noise.js';
import { cleanDiscordFormatting } from './text-discord.js';
import { replaceExactAcronyms } from './acronyms.js';
import { normalizeShoutingCase } from './text-case.js';
import { hasSpeakableImage, sanitizeSpeechContent } from './message-speech-policy.js';

const USER_MENTION_PATTERN = /<@!?(\d+)>/gu;
const ROLE_MENTION_PATTERN = /<@&(\d+)>/gu;
const CHANNEL_MENTION_PATTERN = /<#(\d+)>/gu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\u2060\uFEFF]/gu;

function normalizeGoogleText(text) {
  return text
    .replace(/([!?.,])\1{2,}/gu, '$1')
    .replace(/(\p{L})\1{3,}/giu, '$1$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeGeminiText(text) {
  // Gemini text is intentionally only lightly sanitized. The MessageCreate
  // eligibility layer has already removed non-chat payloads; this step only
  // removes transport/Discord noise while preserving the user's lexical text.
  let value = String(text ?? '')
    .replace(CONTROL_PATTERN, ' ')
    .replace(ZERO_WIDTH_PATTERN, '')
    .replace(/[\t\r\n ]+/gu, ' ')
    .trim();

  if (settings.geminiText?.punctuationCapEnabled !== false) {
    const maxRepeat = Math.max(1, Math.min(Math.floor(Number(settings.geminiText?.punctuationRepeatMax) || 2), 3));
    value = value
      .replace(/!{2,}/gu, (match) => '!'.repeat(Math.min(match.length, maxRepeat)))
      .replace(/\?{2,}/gu, (match) => '?'.repeat(Math.min(match.length, maxRepeat)))
      .replace(/\.{4,}/gu, '...');
  }

  return value;
}

function resolveGeminiMentions(message, text) {
  let resolved = String(text ?? '');

  resolved = resolved.replace(USER_MENTION_PATTERN, (_matched, userId) => {
    return getDisplayName(message.guild, userId, message) || _matched;
  });

  resolved = resolved.replace(CHANNEL_MENTION_PATTERN, (_matched, channelId) => {
    return message.guild.channels.cache.get(channelId)?.name || _matched;
  });

  resolved = resolved.replace(ROLE_MENTION_PATTERN, (_matched, roleId) => {
    return message.guild.roles?.cache?.get(roleId)?.name || _matched;
  });

  return resolved;
}

function cleanGeminiDiscordText(message, text) {
  const cleaned = cleanDiscordFormatting(resolveGeminiMentions(message, text), {
    codePhrase: '',
    resolveChannelName: (channelId) => message.guild.channels.cache.get(channelId)?.name ?? null,
    resolveRoleName: (roleId) => message.guild.roles?.cache?.get(roleId)?.name ?? null
  });
  return normalizeGeminiText(cleaned);
}

function graphemes(value) {
  const text = String(value ?? '');
  if (typeof Intl?.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return [...segmenter.segment(text)].map((entry) => entry.segment);
  }
  return Array.from(text);
}

function graphemeLength(value) {
  return graphemes(value).length;
}

function sliceGraphemes(value, count) {
  return graphemes(value).slice(0, Math.max(0, count)).join('');
}

function truncateRawSpeech(text, maximumCharacters) {
  const max = Number(maximumCharacters);
  const value = String(text ?? '');
  const units = graphemes(value);
  if (!Number.isFinite(max) || max <= 0 || units.length <= max) return value;

  const candidate = units.slice(0, max + 1);
  let lastWhitespace = -1;
  for (let i = 0; i < Math.min(max, candidate.length); i += 1) {
    if (/^\s$/u.test(candidate[i])) lastWhitespace = i;
  }
  if (lastWhitespace >= Math.floor(max * 0.55)) return candidate.slice(0, lastWhitespace).join('').trimEnd();
  return units.slice(0, max).join('').trimEnd();
}

export function truncateSpeechNaturally(text, maximumCharacters) {
  const max = Number(maximumCharacters);
  const units = graphemes(text);
  if (!Number.isFinite(max) || max <= 0 || units.length <= max) return String(text ?? '');

  const candidate = units.slice(0, max + 1);
  const sentenceFloor = Math.floor(max * 0.75);
  const phraseFloor = Math.floor(max * 0.7);
  const wordFloor = Math.floor(max * 0.5);

  let cut = -1;
  for (let i = 0; i < Math.min(max, candidate.length); i += 1) {
    const current = candidate[i];
    const next = candidate[i + 1] ?? '';
    if (/[.!?]/u.test(current) && (!next || /^\s$/u.test(next)) && i + 1 >= sentenceFloor) cut = i + 1;
  }

  if (cut < 0) {
    for (let i = 0; i < Math.min(max, candidate.length); i += 1) {
      const current = candidate[i];
      const next = candidate[i + 1] ?? '';
      if (/[,;:]/u.test(current) && (!next || /^\s$/u.test(next)) && i + 1 >= phraseFloor) cut = i + 1;
    }
  }

  if (cut < 0) {
    for (let i = Math.min(max, candidate.length) - 1; i >= wordFloor; i -= 1) {
      if (/^\s$/u.test(candidate[i])) { cut = i; break; }
    }
  }

  if (cut < 0) cut = max;
  let result = units.slice(0, cut).join('').trimEnd();
  if (!/[.!?]$/u.test(result) && max >= 8) {
    result = result.replace(/[,;:]+$/u, '').trimEnd();
    if (graphemeLength(result) < max) result += '.';
  }
  return sliceGraphemes(result, max);
}

function getDisplayName(guild, userId, message = null) {
  const alias = getUserAlias(guild.id, userId);
  if (alias) return alias;

  const member = message?.mentions?.members?.get(userId) || guild.members.cache.get(userId);
  if (member?.displayName) return member.displayName;

  const user = message?.mentions?.users?.get(userId) || guild.client.users.cache.get(userId);
  return user?.globalName || user?.username || null;
}

function makeMentionToken(text, index) {
  let salt = 0;
  while (true) {
    const token = `\uE000m${index.toString(36)}_${salt.toString(36)}\uE001`;
    if (!text.includes(token)) return token;
    salt += 1;
  }
}

function protectMentions(message, text) {
  const replacements = [];
  const source = String(text ?? '');
  const add = (name) => {
    if (!name) return ' ';
    const token = makeMentionToken(source, replacements.length);
    replacements.push({ token, name });
    return ` ${token} `;
  };

  let protectedText = source.replace(USER_MENTION_PATTERN, (_matched, userId) => add(getDisplayName(message.guild, userId, message)));
  protectedText = protectedText.replace(ROLE_MENTION_PATTERN, (_matched, roleId) => add(message.guild.roles?.cache?.get(roleId)?.name ?? null));
  return { protectedText, replacements };
}

function restoreUserMentions(text, replacements) {
  let restored = text;
  for (const { token, name } of replacements) restored = restored.replaceAll(token, name);
  return restored;
}

function getSpeakerName(message) {
  return (
    getUserAlias(message.guild.id, message.author.id) ||
    message.member?.displayName ||
    message.author.globalName ||
    message.author.username
  );
}

function buildSpeakerLabel(message, guildSettings) {
  if (guildSettings.speakerMode === 'none') return null;
  const username = getSpeakerName(message);
  if (!username) return null;
  return guildSettings.speakerMode === 'cakap' ? `${username} cakap` : username;
}

function finalizeRawSpeech(text, extraParts) {
  const maximumCharacters = Number(settings.maximumCharacters ?? 400);
  const terminalGuardEnabled = settings.geminiText?.terminalPeriodGuard !== false;
  const contentLimit = Number.isFinite(maximumCharacters) && maximumCharacters > 1 && terminalGuardEnabled
    ? maximumCharacters - 1
    : maximumCharacters;
  const extras = extraParts.filter(Boolean).join(', ').trim();
  let base = String(text ?? '').trim();
  if (!base && !extras) return '';

  if (Number.isFinite(contentLimit) && contentLimit > 0 && extras) {
    const separator = base ? ', ' : '';
    const reserved = graphemeLength(separator) + graphemeLength(extras);
    const availableForBase = Math.max(0, contentLimit - reserved);
    base = truncateRawSpeech(base, availableForBase);
    if (!base && graphemeLength(extras) > contentLimit) {
      const onlyExtras = truncateRawSpeech(extras, contentLimit);
      return terminalGuardEnabled && /[\p{L}\p{N}\])}"'”’]$/u.test(onlyExtras) ? `${onlyExtras}.` : onlyExtras;
    }
  }

  let speech = [base, extras].filter(Boolean).join(', ').trim();
  if (Number.isFinite(contentLimit) && contentLimit > 0) speech = truncateRawSpeech(speech, contentLimit);
  if (terminalGuardEnabled && /[\p{L}\p{N}\])}"'”’]$/u.test(speech)) speech += '.';
  return speech;
}

function finalizeSpeech(text, extraParts) {
  const maximumCharacters = Number(settings.maximumCharacters ?? 400);
  const extras = extraParts.filter(Boolean).join(', ').trim();
  let base = String(text ?? '').trim();
  if (!base && !extras) return '';

  if (Number.isFinite(maximumCharacters) && maximumCharacters > 0 && extras) {
    const separator = base ? ', ' : '';
    const reserved = graphemeLength(separator) + graphemeLength(extras);
    const availableForBase = Math.max(0, maximumCharacters - reserved);
    base = truncateSpeechNaturally(base, availableForBase);
    if (!base && graphemeLength(extras) > maximumCharacters) return truncateSpeechNaturally(extras, maximumCharacters);
  }

  let speech = '';
  if (base && extras) {
    // Google fallback intonation may already have added terminal punctuation to
    // the message. Do not create awkward output such as "Nah., hantar gambar".
    speech = /[.!?…]["')\]]*$/u.test(base)
      ? `${base} ${extras}`
      : `${base}, ${extras}`;
  } else {
    speech = base || extras;
  }
  speech = speech.trim();
  return Number.isFinite(maximumCharacters) && maximumCharacters > 0
    ? truncateSpeechNaturally(speech, maximumCharacters)
    : speech;
}

export function prepareSpeechVariants(message, guildSettings) {
  // All Discord payload eligibility/sanitization lives in message-speech-policy.
  // This function only performs pronunciation/formatting after that decision.
  const original = sanitizeSpeechContent(message.content ?? '');

  // Gemini path: light deterministic cleanup only. Username/speaker identity is
  // deliberately kept OUT of this text and voiced separately in audio.js.
  const geminiBaseText = cleanGeminiDiscordText(message, original);

  // Non-spoken reference used only for cutoff diagnostics; never sent to Gemini.
  let verificationText = stripSymbolNoise(stripTextEmoticons(geminiBaseText));
  verificationText = normalizeGeminiText(verificationText);

  // Google Malay safety fallback keeps the mature local pronunciation path.
  const { protectedText, replacements: mentionReplacements } = protectMentions(message, original);
  let commonProtectedText = cleanDiscordFormatting(protectedText, {
    codePhrase: '',
    resolveChannelName: (channelId) => message.guild.channels.cache.get(channelId)?.name ?? null,
    resolveRoleName: (roleId) => message.guild.roles?.cache?.get(roleId)?.name ?? null
  });
  commonProtectedText = stripSymbolNoise(stripTextEmoticons(commonProtectedText));

  let googleText = replaceExactAcronyms(commonProtectedText);
  googleText = replaceDictionaryWords(googleText, message.guild.id);
  googleText = normalizeShoutingCase(googleText);
  googleText = applyContextDictionaries(googleText);
  googleText = normalizeGoogleText(googleText);
  googleText = restoreUserMentions(googleText, mentionReplacements);

  if (settings.intonation?.enabled !== false) googleText = addIntonationCues(googleText);

  // Images are the only non-text payload intentionally spoken by normal chat.
  const extras = hasSpeakableImage(message) ? [settings.imagePhrase] : [];
  const geminiText = finalizeRawSpeech(geminiBaseText, extras);
  verificationText = finalizeSpeech(verificationText, extras);

  return {
    speakerLabel: buildSpeakerLabel(message, guildSettings),
    geminiText,
    geminiVerificationText: verificationText,
    googleText: finalizeSpeech(googleText, extras)
  };
}

export function prepareSpeech(message, guildSettings) {
  return prepareSpeechVariants(message, guildSettings).googleText;
}
