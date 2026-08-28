export function selectPrefetchCandidates(queue, { ahead = 1 } = {}) {
  const items = Array.isArray(queue) ? queue : [];
  const target = Math.max(0, Math.floor(Number(ahead) || 0));
  const prefetchedItems = items.filter((item) => Boolean(item.generation));
  const slots = Math.max(0, target - prefetchedItems.length);
  if (slots <= 0) return [];

  // Latency-first rule: preserve strict FIFO. A later message being ready cannot
  // help playback while an earlier message is still unstarted, so speculative
  // voice diversity only creates head-of-line blocking.
  return items.filter((item) => !item.generation).slice(0, slots);
}
