import { loadSettings, saveSettings, modelsFrom } from "./lib/settings.js";
import { PROVIDERS, callLLM } from "./lib/llm.js";
import { cacheClear } from "./lib/cache.js";

const $ = (id) => document.getElementById(id);
const HELP = {
  anthropic: "Create one at console.anthropic.com → API keys. Starts with sk-ant-",
  openai: "Create one at platform.openai.com → API keys. Starts with sk-. Also lets you transcribe videos without captions.",
};
const clean = (v) => v.trim().replace(/^['"]|['"]$/g, "");

function provider() {
  return document.querySelector("input[name=provider]:checked")?.value || "anthropic";
}

function showProvider() {
  $("key-help").textContent = HELP[provider()];
  $("llmModel").placeholder = PROVIDERS[provider()].defaultModel;
  $("fastModel").placeholder = PROVIDERS[provider()].fastModel;
  $("fast-row").hidden = !$("economy").checked;
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
  for (const f of ["llmKey", "llmModel", "fastModel", "openalexKey", "s2Key", "maxClaims"]) $(f).value = s[f];
  $("economy").checked = s.economy;
  showProvider();
}

async function save() {
  const p = provider();
  const values = {
    provider: p,
    llmKey: clean($("llmKey").value),
    llmModel: clean($("llmModel").value),
    fastModel: clean($("fastModel").value),
    economy: $("economy").checked,
    openalexKey: clean($("openalexKey").value),
    s2Key: clean($("s2Key").value),
    maxClaims: Math.max(1, Math.min(10, parseInt($("maxClaims").value, 10) || 5)),
  };
  for (const f of ["llmKey", "llmModel", "fastModel", "openalexKey", "s2Key"]) $(f).value = values[f];
  await saveSettings(values);
  const warning = looksWrong(p, values.llmKey);
  warning ? say(`Saved, but: ${warning}`, false) : say("Saved ✓", true);
}

async function test() {
  await save();
  const s = await loadSettings();
  if (!s.llmKey) return say("Enter a key first.", false);
  say("Testing…", true);
  try {
    const models = modelsFrom(s);
    // test every model the checks will use, so a typo in either name shows up now
    const used = [...new Set([models.main.model, models.fast.model])];
    for (const llm of [models.main, models.fast].filter((m, i, a) => a.findIndex((x) => x.model === m.model) === i))
      await callLLM(llm, 'Reply with the JSON {"ok": true}.', "ping", 20);
    say(`Key works ✓ (${used.join(" + ")})`, true);
  } catch (e) {
    say(e.message, false);
  }
}

document.querySelectorAll("input[name=provider]").forEach(
  (r) =>
    (r.onchange = () => {
      $("llmModel").value = ""; // a model name only makes sense for its own provider
      $("fastModel").value = "";
      showProvider();
    })
);
$("economy").onchange = showProvider;
$("save").onclick = save;
$("test").onclick = test;
$("clear").onclick = async () => {
  for (const f of ["llmKey", "openalexKey", "s2Key"]) $(f).value = "";
  await saveSettings({ llmKey: "", openalexKey: "", s2Key: "" });
  say("Keys removed from this browser.", true);
};
$("clear-cache").onclick = async () => {
  await cacheClear();
  say("Saved results cleared.", true);
};
init();
