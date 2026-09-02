import { stripTextEmoticons } from './text-emoticons.js';

const SCHEME_URL_PATTERN = /\bhttps?:\/\/\S+|\bwww\.\S+/giu;
const BARE_DOMAIN_PATTERN = /(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?::\d{2,5})?(?:\/[^\s<]*)?/giu;
const MASKED_LINK_PATTERN = /\[([^\]\n]{1,200})\]\((?:https?:\/\/|www\.)[^)\s]+(?:\s+"[^"]*")?\)/giu;
const AUTOLINK_PATTERN = /<(?:https?:\/\/|www\.)[^>\s]+>/giu;
const FENCED_CODE_PATTERN = /```[\s\S]*?```|```[\s\S]*$/gu;
const INLINE_CODE_PATTERN = /`[^`\r\n]+`/gu;
const CUSTOM_EMOJI_PATTERN = /<a?:[\w-]+:\d+>/gu;
const DISCORD_MENTION_PATTERN = /<@!?\d+>|<@&\d+>|<#\d+>/u;
const EMOJI_CLUSTER_MARKER = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}]|\u20E3|\uFE0F/u;

// A broad bare-domain matcher catches new/less-common TLDs without maintaining
// a fragile allowlist. Preserve obvious filename/code tokens such as app.js or
// config.json so normal technical chat is not accidentally swallowed as a URL.
const FILE_LIKE_SUFFIXES = new Set([
  '7z', 'avif', 'bat', 'bmp', 'c', 'cmd', 'cpp', 'css', 'csv', 'dll', 'exe',
  'flac', 'gif', 'gz', 'h', 'heic', 'heif', 'hpp', 'ini', 'java', 'jfif', 'jpg',
  'jpeg', 'js', 'json', 'jsx', 'jxl', 'less', 'log', 'm4v', 'md', 'mkv', 'mov',
  'mp3', 'mp4', 'ogg', 'opus', 'pdf', 'png', 'ps1', 'py', 'rar', 'sass', 'scss',
  'sh', 'svg', 'tar', 'tif', 'tiff', 'ts', 'tsx', 'txt', 'wav', 'webm', 'webp',
  'xml', 'yaml', 'yml', 'zip'
]);

function stripUnicodeEmoji(input) {
  const text = String(input ?? '');
  if (!text) return '';

  if (typeof Intl?.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return [...segmenter.segment(text)]
      .map((entry) => EMOJI_CLUSTER_MARKER.test(entry.segment) ? ' ' : entry.segment)
      .join('');
  }

  return text
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}]/gu, ' ')
    .replace(/[\u200D\u20E3\uFE0E\uFE0F]/gu, ' ');
}

function isLikelyFileToken(value) {
  const host = String(value ?? '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase();
  const suffix = host.split('.').at(-1) ?? '';
  return FILE_LIKE_SUFFIXES.has(suffix);
}

function stripBareDomains(input) {
  return String(input ?? '').replace(BARE_DOMAIN_PATTERN, (matched) => isLikelyFileToken(matched) ? matched : ' ');
}

function isGifAttachment(attachment) {
  return String(attachment?.contentType ?? '').toLowerCase() === 'image/gif' || /\.gif$/iu.test(attachment?.name ?? '');
}

function isImageAttachment(attachment) {
  return !isGifAttachment(attachment) && (
    String(attachment?.contentType ?? '').toLowerCase().startsWith('image/') ||
    /\.(png|jpe?g|jfif|webp|bmp|avif|heic|heif|jxl|tiff?)$/iu.test(attachment?.name ?? '')
  );
}

function isImageEmbed(embed) {
  const type = String(embed?.type ?? '').toLowerCase();
  if (type === 'gifv' || type === 'video' || embed?.video) return false;
  if (type === 'link' || type === 'article' || type === 'rich') return false;
  return type === 'image' || Boolean(embed?.image);
}

export function sanitizeSpeechContent(input) {
  let text = String(input ?? '');
  if (!text) return '';

  // Non-chat payloads are intentionally silent. If a user adds normal text
  // beside one of these items, only that normal text remains eligible for TTS.
  text = text
    .replace(FENCED_CODE_PATTERN, ' ')
    .replace(INLINE_CODE_PATTERN, ' ')
    .replace(MASKED_LINK_PATTERN, ' ')
    .replace(AUTOLINK_PATTERN, ' ')
    .replace(SCHEME_URL_PATTERN, ' ')
    .replace(CUSTOM_EMOJI_PATTERN, ' ');
  text = stripBareDomains(text);
  text = stripUnicodeEmoji(text);
  text = stripTextEmoticons(text);
  return text.replace(/[\t\r\n ]+/gu, ' ').trim();
}

export function buildSpeakableMessage(message) {
  const content = sanitizeSpeechContent(message?.content ?? '');
  const attachments = new Map(
    [...(message?.attachments?.entries?.() ?? [])].filter(([, attachment]) => isImageAttachment(attachment))
  );
  const embeds = [...(message?.embeds ?? [])].filter(isImageEmbed);

  const hasMention = DISCORD_MENTION_PATTERN.test(content) || /(^|\s)@(everyone|here)(?=\s|$|[.,!?;:])/iu.test(content);
  const hasNormalText = /[\p{L}\p{N}]/u.test(content);
  const hasImage = attachments.size > 0 || embeds.length > 0;
  if (!hasNormalText && !hasMention && !hasImage) return null;

  return {
    content,
    attachments,
    embeds,
    guild: message.guild,
    mentions: message.mentions,
    member: message.member,
    author: message.author
  };
}

export const __test = { stripUnicodeEmoji, stripBareDomains, isLikelyFileToken, isImageAttachment, isImageEmbed };
