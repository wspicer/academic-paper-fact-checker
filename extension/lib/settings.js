// All settings, including keys, live in chrome.storage.local: this browser only, never synced.
import { PROVIDERS, resolveLLM } from "./llm.js";

export const DEFAULTS = {
  provider: "anthropic",
  llmKey: "",
  llmModel: "",
  openalexKey: "",
  s2Key: "",
  maxClaims: 5,
};

export async function loadSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  if (!PROVIDERS[s.provider]) s.provider = "anthropic";
  return s;
}

export function saveSettings(values) {
  return chrome.storage.local.set(values);
}

export function llmFrom(s) {
  return resolveLLM({ provider: s.provider, key: s.llmKey, model: s.llmModel });
}

export function searchKeys(s) {
  return { openalexKey: s.openalexKey, s2Key: s.s2Key };
}

// One-time cleanup of settings from the old server-based version.
export async function migrate() {
  await chrome.storage.sync.remove(["backendUrl", "apiToken", "maxClaims"]).catch(() => {});
  await chrome.storage.local.remove(["installId"]).catch(() => {});
}
