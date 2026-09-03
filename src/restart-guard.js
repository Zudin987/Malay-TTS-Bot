export function getTtsRestartBlockers({ guildIds = [], getAudioStatus, getProviderStatus, getAskStatus, getLabelStatus } = {}) {
  const uniqueGuildIds = [...new Set((guildIds ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
  const busyGuilds = [];

  if (typeof getAudioStatus === 'function') {
    for (const guildId of uniqueGuildIds) {
      const audio = getAudioStatus(guildId) ?? {};
      const queued = Math.max(0, Number(audio.queued) || 0);
      const playing = Boolean(audio.playing);
      if (audio.active || playing || queued > 0) busyGuilds.push({ guildId, playing, queued });
    }
  }

  const provider = typeof getProviderStatus === 'function' ? (getProviderStatus() ?? {}) : {};
  const limiter = provider.geminiLimiter ?? {};
  const providerActive = Math.max(0, Number(limiter.active) || 0);
  const providerQueued = Math.max(0, Number(limiter.queued) || 0);
  const askActive = Math.max(0, Number(getAskStatus?.()?.active) || 0);
  const labelActive = Math.max(0, Number(getLabelStatus?.()?.inflight) || 0);

  return {
    safe: busyGuilds.length === 0 && providerActive === 0 && providerQueued === 0 && askActive === 0 && labelActive === 0,
    busyGuilds,
    providerActive,
    providerQueued, askActive, labelActive
  };
}

export function describeTtsRestartBlockers(blockers = {}) {
  const parts = [];
  const busyGuilds = Array.isArray(blockers.busyGuilds) ? blockers.busyGuilds : [];
  if (busyGuilds.length) {
    const playing = busyGuilds.filter((entry) => entry.playing).length;
    const queued = busyGuilds.reduce((sum, entry) => sum + Math.max(0, Number(entry.queued) || 0), 0);
    parts.push(`${busyGuilds.length} guild queue(s) busy${playing ? ` • ${playing} playing` : ''}${queued ? ` • ${queued} queued` : ''}`);
  }
  const active = Math.max(0, Number(blockers.providerActive) || 0);
  const waiting = Math.max(0, Number(blockers.providerQueued) || 0);
  if (active || waiting) parts.push(`Gemini work ${active} active • ${waiting} waiting`);
  if (blockers.askActive) parts.push(`/ask ${blockers.askActive} active`);
  if (blockers.labelActive) parts.push(`speaker labels ${blockers.labelActive} active`);
  return parts.join(' • ') || 'runtime busy';
}
