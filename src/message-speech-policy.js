import { stripTextEmoticons } from './text-emoticons.js';

const URL_PATTERN = /\bhttps?:\/\/\S+|\bwww\.\S+|(?<![@\w])(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+(?:com|net|org|gg|io|me|tv|co|my|dev|app|ai|ly|be)(?:\/[^\s<]*)?/giu;
const MASKED_LINK_PATTERN = /\[([^\]\n]{1,200})\]\((?:https?:\/\/|www\.)[^)\s]+(?:\s+"[^"]*")?\)/giu;
const AUTOLINK_PATTERN = /<(?:https?:\/\/|www\.)[^>\s]+>/giu;
const FENCED_CODE_PATTERN = /```[\s\S]*?```|```[\s\S]*$/gu;
const CUSTOM_EMOJI_PATTERN = /<a?:[\w-]+:\d+>/gu;
const DISCORD_MENTION_PATTERN = /<@!?\d+>|<@&\d+>|<#\d+>/u;
const EMOJI_CLUSTER_MARKER = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}]|\u20E3|\uFE0F/u;

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

function isGifAttachment(attachment) {
  return String(attachment?.contentType ?? '').toLowerCase() === 'image/gif' || /\.gif$/iu.test(attachment?.name ?? '');
}

function isImageAttachment(attachment) {
  return !isGifAttachment(attachment) && (
    String(attachment?.contentType ?? '').toLowerCase().startsWith('image/') ||
    /\.(png|jpe?g|webp|bmp|avif)$/iu.test(attachment?.name ?? '')
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
    .replace(MASKED_LINK_PATTERN, ' ')
    .replace(AUTOLINK_PATTERN, ' ')
    .replace(URL_PATTERN, ' ')
    .replace(CUSTOM_EMOJI_PATTERN, ' ');
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

export const __test = { stripUnicodeEmoji, isImageAttachment, isImageEmbed };
