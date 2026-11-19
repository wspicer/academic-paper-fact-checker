// Shared by the side panel and the options page.
// The API key lives in chrome.storage.local (this browser only, never synced).
const SYNC_DEFAULTS = { backendUrl: "http://localhost:8000", apiToken: "", maxClaims: 5 };
const LOCAL_DEFAULTS = { provider: "anthropic", llmKey: "", llmModel: "", installId: "" };

async function loadSettings() {
  const sync = await chrome.storage.sync.get(Object.keys(SYNC_DEFAULTS));
  const local = await chrome.storage.local.get(Object.keys(LOCAL_DEFAULTS));
  const s = { ...SYNC_DEFAULTS, ...sync, ...LOCAL_DEFAULTS, ...local };
  if (!s.installId) {
    s.installId = crypto.randomUUID();
    await chrome.storage.local.set({ installId: s.installId });
  }
  return s;
}

function authHeaders(s) {
  const h = { "X-Install-Id": s.installId };
  if (s.apiToken) h["X-API-Token"] = s.apiToken;
  if (s.llmKey) {
    h["X-LLM-Provider"] = s.provider;
    h["X-LLM-Key"] = s.llmKey;
    if (s.llmModel) h["X-LLM-Model"] = s.llmModel;
  }
  return h;
}

function serverUrl(s, path) {
  return s.backendUrl.replace(/\/$/, "") + path;
}
