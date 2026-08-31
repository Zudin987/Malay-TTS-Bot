import 'dotenv/config';

const MAX_GEMINI_API_KEYS = 5;

function slotEnvName(slot) {
  return slot === 1 ? 'GEMINI_API_KEY' : `GEMINI_API_KEY_${slot}`;
}

function normalizeRequestedSlot(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_GEMINI_API_KEYS ? parsed : 1;
}

function configuredEntries(env = process.env) {
  const configured = [];
  for (let slot = 1; slot <= MAX_GEMINI_API_KEYS; slot += 1) {
    const key = String(env?.[slotEnvName(slot)] ?? '').trim();
    if (key) configured.push({ slot, key });
  }
  return configured;
}

export function getGeminiApiKeySelection(env = process.env) {
  const configured = configuredEntries(env);
  const requestedSlot = normalizeRequestedSlot(env?.GEMINI_API_KEY_SLOT);
  const selected = configured.find((entry) => entry.slot === requestedSlot)
    ?? configured.find((entry) => entry.slot === 1)
    ?? configured[0]
    ?? null;

  return {
    key: selected?.key ?? null,
    selectedSlot: selected?.slot ?? null,
    requestedSlot,
    configuredCount: configured.length,
    configuredSlots: configured.map((entry) => entry.slot)
  };
}

export function createGeminiApiKeyRoundRobin(env = process.env) {
  const configured = configuredEntries(env);
  const requestedSlot = normalizeRequestedSlot(env?.GEMINI_API_KEY_SLOT);
  let startIndex = configured.findIndex((entry) => entry.slot === requestedSlot);
  if (startIndex < 0) startIndex = 0;
  let cursor = startIndex;
  let lastSlot = null;
  const disabledSlots = new Set();

  const availableEntries = () => configured.filter((entry) => !disabledSlots.has(entry.slot));
  const peekNext = () => {
    if (!configured.length || availableEntries().length === 0) return null;
    for (let offset = 0; offset < configured.length; offset += 1) {
      const entry = configured[(cursor + offset) % configured.length];
      if (!disabledSlots.has(entry.slot)) return entry;
    }
    return null;
  };
  const status = () => {
    const next = peekNext();
    return {
      configuredCount: configured.length,
      configuredSlots: configured.map((entry) => entry.slot),
      availableCount: availableEntries().length,
      disabledSlots: [...disabledSlots].sort((a, b) => a - b),
      requestedSlot,
      startSlot: configured[startIndex]?.slot ?? null,
      lastSlot,
      nextSlot: next?.slot ?? null
    };
  };

  return {
    next() {
      const next = peekNext();
      if (!next) return null;
      const index = configured.findIndex((entry) => entry.slot === next.slot);
      cursor = (index + 1) % configured.length;
      lastSlot = next.slot;
      return { ...next };
    },
    disable(slot) {
      const numeric = Number(slot);
      if (configured.some((entry) => entry.slot === numeric)) disabledSlots.add(numeric);
      return status();
    },
    reset() {
      disabledSlots.clear();
      cursor = startIndex;
      lastSlot = null;
      return status();
    },
    status
  };
}

const runtimeRoundRobin = createGeminiApiKeyRoundRobin(process.env);

export function nextGeminiApiKey() {
  return runtimeRoundRobin.next();
}

export function disableGeminiApiKeySlot(slot) {
  return runtimeRoundRobin.disable(slot);
}

export function resetGeminiApiKeyRoundRobin() {
  return runtimeRoundRobin.reset();
}

export function getGeminiApiKeyRoundRobinStatus() {
  return runtimeRoundRobin.status();
}

export const __test = { MAX_GEMINI_API_KEYS, slotEnvName, normalizeRequestedSlot, configuredEntries };
