const MAX_GEMINI_API_KEYS = 5;

function slotEnvName(slot) {
  return slot === 1 ? 'GEMINI_API_KEY' : `GEMINI_API_KEY_${slot}`;
}

function normalizeRequestedSlot(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_GEMINI_API_KEYS ? parsed : 1;
}

export function getGeminiApiKeySelection(env = process.env) {
  const configured = [];
  for (let slot = 1; slot <= MAX_GEMINI_API_KEYS; slot += 1) {
    const key = String(env?.[slotEnvName(slot)] ?? '').trim();
    if (key) configured.push({ slot, key });
  }

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

export function applyGeminiApiKeySelection(env = process.env) {
  const selection = getGeminiApiKeySelection(env);
  if (selection.key) env.GEMINI_API_KEY = selection.key;
  env.GEMINI_API_KEY_ACTIVE_SLOT = selection.selectedSlot == null ? '' : String(selection.selectedSlot);
  env.GEMINI_API_KEY_CONFIGURED_COUNT = String(selection.configuredCount);
  return selection;
}

export const __test = { MAX_GEMINI_API_KEYS, slotEnvName, normalizeRequestedSlot };
