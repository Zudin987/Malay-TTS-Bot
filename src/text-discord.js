// Discord markup is useful visually but often sounds terrible when read aloud.
// This cleaner keeps the human-readable words while removing formatting syntax.

const FENCED_CODE_PATTERN = /```[\s\S]*?```/gu;
const UNCLOSED_FENCED_CODE_PATTERN = /```[\s\S]*$/gu;
const INLINE_CODE_PATTERN = /`([^`\n]{1,200})`/gu;
const MASKED_LINK_PATTERN = /\[([^\]\n]{1,200})\]\((?:https?:\/\/|www\.)[^)\s]+(?:\s+"[^"]*")?\)/giu;
const SLASH_COMMAND_MENTION_PATTERN = /<\/([^:>]{1,64}):\d+>/gu;
const TIMESTAMP_MENTION_PATTERN = /<t:\d+(?::[tTdDfFR])?>/gu;
const CHANNEL_MENTION_PATTERN = /<#(\d+)>/gu;
const ROLE_MENTION_PATTERN = /<@&(\d+)>/gu;
const EVERYONE_HERE_PATTERN = /(^|\s)@(everyone|here)(?=\s|$|[.,!?;:])/giu;
const AUTOLINK_WRAPPER_PATTERN = /<(https?:\/\/[^>\s]+)>/giu;

function unwrapPairedFormatting(text) {
  let previous;
  let current = text;

  // A few passes handle nested combinations such as **__text__** without
  // complicated recursive regular expressions.
  for (let pass = 0; pass < 4; pass += 1) {
    previous = current;
    current = current
      .replace(/\*\*([^*\n]+)\*\*/gu, '$1')
      .replace(/__([^_\n]+)__/gu, '$1')
      .replace(/~~([^~\n]+)~~/gu, '$1')
      .replace(/\|\|([^|\n]+)\|\|/gu, '$1')
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/gu, '$1')
      .replace(/(?<!_)_([^_\n]+)_(?!_)/gu, '$1');
    if (current === previous) break;
  }

  return current;
}

export function cleanDiscordFormatting(input, { resolveChannelName = null, resolveRoleName = null, codePhrase = 'hantar code' } = {}) {
  if (!input) return '';

  let text = input
    .replace(FENCED_CODE_PATTERN, ` ${codePhrase} `)
    .replace(UNCLOSED_FENCED_CODE_PATTERN, ` ${codePhrase} `)
    .replace(MASKED_LINK_PATTERN, '$1')
    .replace(SLASH_COMMAND_MENTION_PATTERN, (_matched, name) => ` ${name.trim()} `)
    .replace(TIMESTAMP_MENTION_PATTERN, ' ')
    .replace(CHANNEL_MENTION_PATTERN, (_matched, channelId) => {
      const name = typeof resolveChannelName === 'function' ? resolveChannelName(channelId) : null;
      return name ? ` ${name} ` : ' ';
    })
    .replace(ROLE_MENTION_PATTERN, (_matched, roleId) => {
      const name = typeof resolveRoleName === 'function' ? resolveRoleName(roleId) : null;
      return name ? ` ${name} ` : ' ';
    })
    .replace(EVERYONE_HERE_PATTERN, (_matched, prefix, target) => `${prefix}${target.toLowerCase()}`)
    .replace(AUTOLINK_WRAPPER_PATTERN, '$1')
    .replace(INLINE_CODE_PATTERN, '$1')
    // Line-level markdown structure.
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/^\s{0,3}>+\s?/gmu, '')
    .replace(/^\s{0,3}[-+*]\s+/gmu, '')
    // Markdown escapes such as \*literal\* should become the literal symbol.
    .replace(/\\([*_~|`>#])/gu, '$1');

  text = unwrapPairedFormatting(text);

  // Leftover formatting-only runs should not reach Google TTS. Keep ordinary
  // punctuation and underscores inside identifiers untouched.
  return text
    .replace(/(?:\*\*|__|~~|\|\|){1,}/gu, ' ')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, ' ');
}
