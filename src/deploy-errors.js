function clean(value) {
  return String(value ?? '').replace(/[\r\n]+/gu, ' ').trim();
}

export function describeDiscordDeployError(error, { clientId, guildId } = {}) {
  const status = Number(error?.status);
  const code = error?.code;
  const raw = clean(error?.rawError?.message || error?.message || 'Unknown Discord API error');
  const scope = guildId ? `guild ${guildId}` : 'global commands';

  if (status === 401) {
    return [
      'Discord rejected DISCORD_TOKEN (401 Unauthorized).',
      'Reset/copy the Bot Token from Discord Developer Portal > Bot for the same application as DISCORD_CLIENT_ID.',
      'Put only the raw token in .env; do not include the word "Bot" or surrounding copy/paste whitespace.',
      clientId ? `DISCORD_CLIENT_ID currently points to application ${clientId}.` : null,
      'After correcting .env, run deploy-commands.cmd again.'
    ].filter(Boolean).join('\n');
  }

  if (status === 403) {
    return [
      `Discord authenticated the request but refused command deployment to ${scope} (403 Forbidden).`,
      'Confirm DISCORD_CLIENT_ID belongs to the same bot token and that the bot/application is installed in the target guild with the required application-command scope.',
      guildId ? `DISCORD_GUILD_ID currently points to ${guildId}.` : null
    ].filter(Boolean).join('\n');
  }

  const statusText = Number.isFinite(status) && status > 0 ? ` HTTP ${status}` : '';
  const codeText = code !== undefined && code !== null ? ` / code ${clean(code)}` : '';
  return `Discord command deployment failed${statusText}${codeText}: ${raw}`;
}
