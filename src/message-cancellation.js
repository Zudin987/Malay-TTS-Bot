export function cancelDeletedMessage(message, cancel, guildId = null) {
  const guild = guildId || message?.guildId || message?.guild?.id;
  if (!guild || !message?.id) return false;
  return cancel(guild, message.id);
}

export function cancelDeletedMessages(messages, cancel, channel = null) {
  const guildId = channel?.guildId || channel?.guild?.id;
  let count = 0;
  for (const message of messages?.values?.() || []) {
    if (cancelDeletedMessage(message, cancel, guildId)) count++;
  }
  return count;
}
