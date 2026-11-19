const $ = (id) => document.getElementById(id);
const HELP = {
  anthropic: "Create one at console.anthropic.com → API keys. Starts with sk-ant-",
  openai: "Create one at platform.openai.com → API keys. Starts with sk-",
};
const MODEL_DEFAULTS = { anthropic: "claude-sonnet-5-5", openai: "gpt-5.6-sol" };

function provider() {
  return document.querySelector("input[name=provider]:checked")?.value || "anthropic";
}

function showProvider() {
  $("key-help").textContent = HELP[provider()];
  $("llmModel").placeholder = MODEL_DEFAULTS[provider()];
}

function say(msg, ok) {
  $("result").textContent = msg;
  $("result").className = ok ? "ok" : "bad";
}

function looksWrong(p, key) {
  if (!key) return null;
  if (p === "anthropic" && !key.startsWith("sk-ant-")) return "That doesn't look like an Anthropic key (sk-ant-…).";
  if (p === "openai" && key.startsWith("sk-ant-")) return "That's an Anthropic key. Switch the provider to Anthropic.";
  if (p === "openai" && !key.startsWith("sk-")) return "That doesn't look like an OpenAI key (sk-…).";
  return null;
}

async function init() {
  const s = await loadSettings();
  document.querySelector(`input[name=provider][value=${s.provider}]`).checked = true;
  $("llmKey").value = s.llmKey;
  $("llmModel").value = s.llmModel;
  $("backendUrl").value = s.backendUrl;
  $("apiToken").value = s.apiToken;
  $("maxClaims").value = s.maxClaims;
  showProvider();
}

async function save() {
  const p = provider();
  const key = $("llmKey").value.trim().replace(/^['"]|['"]$/g, "");
  $("llmKey").value = key;
  const warning = looksWrong(p, key);
  await chrome.storage.local.set({ provider: p, llmKey: key, llmModel: $("llmModel").value.trim() });
  await chrome.storage.sync.set({
    backendUrl: $("backendUrl").value.trim() || SYNC_DEFAULTS.backendUrl,
    apiToken: $("apiToken").value.trim(),
    maxClaims: Math.max(1, Math.min(10, parseInt($("maxClaims").value, 10) || 5)),
  });
  warning ? say(`Saved, but: ${warning}`, false) : say("Saved ✓", true);
}

async function test() {
  await save();
  const s = await loadSettings();
  if (!s.llmKey) return say("Enter a key first.", false);
  say("Testing…", true);
  try {
    const res = await fetch(serverUrl(s, "/check/key"), { method: "POST", headers: authHeaders(s) });
    const data = await res.json().catch(() => ({}));
    res.ok ? say(`Key works ✓ (${data.model})`, true) : say(data.detail || `Server error ${res.status}`, false);
  } catch {
    say(`Can't reach the server at ${s.backendUrl}.`, false);
  }
}

document.querySelectorAll("input[name=provider]").forEach(
  (r) =>
    (r.onchange = () => {
      $("llmModel").value = ""; // a model name only makes sense for its own provider
      showProvider();
    })
);
$("save").onclick = save;
$("test").onclick = test;
$("clear").onclick = async () => {
  $("llmKey").value = "";
  await chrome.storage.local.set({ llmKey: "" });
  say("Key removed.", true);
};
init();
