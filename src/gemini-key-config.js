import 'dotenv/config';

const MAX_GEMINI_API_KEYS = 10;

function slotEnvName(slot) {
  return slot === 1 ? 'GEMINI_API_KEY' : `GEMINI_API_KEY_${slot}`;
}

function normalizeRequestedSlot(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_GEMINI_API_KEYS ? parsed : 1;
}

function analyzeConfiguredEntries(env = process.env) {
  const configured = [];
  const configuredEnvSlots = [];
  const duplicateSlots = [];
  const canonicalSlotByKey = new Map();

  for (let slot = 1; slot <= MAX_GEMINI_API_KEYS; slot += 1) {
    const key = String(env?.[slotEnvName(slot)] ?? '').trim();
    if (!key) continue;
    configuredEnvSlots.push(slot);
    const duplicateOf = canonicalSlotByKey.get(key);
    if (duplicateOf != null) {
      duplicateSlots.push({ slot, duplicateOf });
      continue;
    }
    canonicalSlotByKey.set(key, slot);
    configured.push({ slot, key });
  }

  return {
    configured,
    configuredEnvSlots,
    configuredEnvCount: configuredEnvSlots.length,
    duplicateSlots
  };
}

function configuredEntries(env = process.env) {
  return analyzeConfiguredEntries(env).configured;
}

function effectiveRequestedSlot(requestedSlot, duplicateSlots) {
  return duplicateSlots.find((entry) => entry.slot === requestedSlot)?.duplicateOf ?? requestedSlot;
}

export function getGeminiApiKeyConfiguration(env = process.env) {
  const analysis = analyzeConfiguredEntries(env);
  const requestedSlot = normalizeRequestedSlot(env?.GEMINI_API_KEY_SLOT);
  const effectiveSlot = effectiveRequestedSlot(requestedSlot, analysis.duplicateSlots);
  const selected = analysis.configured.find((entry) => entry.slot === effectiveSlot)
    ?? analysis.configured.find((entry) => entry.slot === 1)
    ?? analysis.configured[0]
    ?? null;

  return {
    requestedSlot,
    selectedSlot: selected?.slot ?? null,
    configuredCount: analysis.configured.length,
    configuredSlots: analysis.configured.map((entry) => entry.slot),
    configuredEnvCount: analysis.configuredEnvCount,
    configuredEnvSlots: analysis.configuredEnvSlots,
    duplicateSlots: analysis.duplicateSlots.map((entry) => ({ ...entry }))
  };
}

export function getGeminiApiKeySelection(env = process.env) {
  const analysis = analyzeConfiguredEntries(env);
  const requestedSlot = normalizeRequestedSlot(env?.GEMINI_API_KEY_SLOT);
  const effectiveSlot = effectiveRequestedSlot(requestedSlot, analysis.duplicateSlots);
  const selected = analysis.configured.find((entry) => entry.slot === effectiveSlot)
    ?? analysis.configured.find((entry) => entry.slot === 1)
    ?? analysis.configured[0]
    ?? null;

  return {
    key: selected?.key ?? null,
    selectedSlot: selected?.slot ?? null,
    requestedSlot,
    configuredCount: analysis.configured.length,
    configuredSlots: analysis.configured.map((entry) => entry.slot),
    configuredEnvCount: analysis.configuredEnvCount,
    configuredEnvSlots: analysis.configuredEnvSlots,
    duplicateSlots: analysis.duplicateSlots.map((entry) => ({ ...entry }))
  };
}

export function createGeminiApiKeyRoundRobin(env = process.env) {
  const analysis = analyzeConfiguredEntries(env);
  const configured = analysis.configured;
  const requestedSlot = normalizeRequestedSlot(env?.GEMINI_API_KEY_SLOT);
  const effectiveSlot = effectiveRequestedSlot(requestedSlot, analysis.duplicateSlots);
  let startIndex = configured.findIndex((entry) => entry.slot === effectiveSlot);
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
      configuredEnvCount: analysis.configuredEnvCount,
      configuredEnvSlots: [...analysis.configuredEnvSlots],
      duplicateSlots: analysis.duplicateSlots.map((entry) => ({ ...entry })),
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

export function formatGeminiApiKeySelectionLog(entry) {
  const slot = Number(entry?.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_GEMINI_API_KEYS) return null;
  return `[gemini-key] slot=${slot}`;
}

const runtimeRoundRobin = createGeminiApiKeyRoundRobin(process.env);

export function nextGeminiApiKey() {
  const entry = runtimeRoundRobin.next();
  const line = formatGeminiApiKeySelectionLog(entry);
  if (line) console.log(line);
  return entry;
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

export const __test = { MAX_GEMINI_API_KEYS, slotEnvName, normalizeRequestedSlot, configuredEntries, analyzeConfiguredEntries, effectiveRequestedSlot };
