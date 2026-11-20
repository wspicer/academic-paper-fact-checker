import { loadSettings, modelsFrom, searchKeys, migrate } from "./lib/settings.js";
import { PROVIDERS, LLMError } from "./lib/llm.js";
import { checkText as runText, checkTranscript, fmtTime } from "./lib/pipeline.js";
import { transcribeWithOpenAI, fetchMedia } from "./lib/transcribe.js";
import { cachePrune } from "./lib/cache.js";

const $ = (id) => document.getElementById(id);
const current = { tabId: null, mode: null, claims: [] };

// ---------- page messaging ----------
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function toPage(tabId, msg) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  return chrome.tabs.sendMessage(tabId, msg);
}

// ---------- UI state ----------
function openSettings(e) {
  e?.preventDefault();
  chrome.runtime.openOptionsPage();
}

function settingsLink(text = "Open settings") {
  return Object.assign(document.createElement("a"), { href: "#", textContent: text, onclick: openSettings });
}

function setBusy(msg) {
  $("status").hidden = !msg;
  $("status").textContent = msg || "";
  document.querySelectorAll("#actions button, #upload").forEach((b) => (b.disabled = !!msg));
}

function showError(msg, withLink) {
  $("error").hidden = !msg;
  $("error").textContent = msg || "";
  if (msg && withLink) $("error").append(" ", settingsLink());
}

async function refreshBanner() {
  const s = await loadSettings();
  const el = $("key-banner");
  el.hidden = false;
  el.innerHTML = "";
  if (s.llmKey) {
    el.className = "banner own";
    el.textContent =
      `Using your ${PROVIDERS[s.provider].label} key` +
      (s.economy ? " · economy mode" : "") +
      (s.openalexKey ? "" : " · tip: add a free OpenAlex key");
  } else {
    el.className = "banner nokey";
    el.append("Add your Anthropic or OpenAI API key to start. ", settingsLink("Add key"));
  }
}

function progress(stage, done, total) {
  if (stage === "claims") setBusy("Finding claims worth checking...");
  else setBusy(`Searching research and weighing evidence... ${done}/${total} claims`);
}

async function run(label, fn) {
  showError("");
  $("results").innerHTML = "";
  $("meta").hidden = true;
  setBusy(label);
  try {
    await fn();
  } catch (e) {
    showError(e.message || String(e), e instanceof LLMError && e.auth);
  } finally {
    setBusy("");
  }
}

async function getModels() {
  const s = await loadSettings();
  return { s, models: modelsFrom(s) }; // throws a friendly LLMError if no key
}

// ---------- rendering ----------
function render(data, mode) {
  current.mode = mode;
  current.claims = data.claims.map((c, i) => ({ id: i + 1, ...c }));
  $("results").innerHTML = "";
  const n = current.claims.length;
  const cached = current.claims.filter((c) => c.cached).length;
  $("meta").hidden = false;
  $("meta").textContent = n
    ? `${n} claim${n > 1 ? "s" : ""} checked in ${data.seconds.toFixed(0)}s` +
      (cached ? ` · ${cached} from cache` : "") +
      (data.economy ? " · economy mode" : "") +
      (data.transcriptMethod ? ` · transcript from ${data.transcriptMethod}` : "")
    : "No research-checkable claims found.";

  const tpl = $("claim-tpl");
  for (const c of current.claims) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const verdict = c.verdict || "error";
    const badge = el.querySelector(".badge");
    badge.textContent = verdict;
    badge.classList.add(verdict.split(" ")[0]);
    el.querySelector(".confidence").textContent = c.confidence ? `${c.confidence} confidence` : "";
    el.querySelector(".claim-text").textContent = c.claim;
    el.querySelector(".summary").textContent = c.summary || "";
    for (const t of c.caveats || []) {
      const li = document.createElement("li");
      li.textContent = t;
      el.querySelector(".caveats").appendChild(li);
    }

    const jump = el.querySelector(".jump");
    if (mode === "video" && c.timestamp != null && current.tabId) {
      jump.hidden = false;
      jump.textContent = `▶ ${fmtTime(c.timestamp)}`;
      jump.onclick = () => toPage(current.tabId, { type: "seek", seconds: c.timestamp });
    } else if (mode === "page" && c.found) {
      jump.hidden = false;
      jump.textContent = "Show on page";
      jump.onclick = () => toPage(current.tabId, { type: "scrollTo", id: c.id });
    }

    const stances = Object.fromEntries((c.papers || []).map((p) => [p.n, p]));
    const evidence = (c.evidence || [])
      .map((p, i) => ({ ...p, stance: stances[i + 1]?.stance || "neutral", note: stances[i + 1]?.note || "" }))
      .filter((p) => p.stance !== "irrelevant");
    el.querySelector(".evidence summary").textContent = `${evidence.length} paper${evidence.length === 1 ? "" : "s"}`;
    const ul = el.querySelector(".papers");
    for (const p of evidence) {
      const li = document.createElement("li");
      const st = Object.assign(document.createElement("span"), { className: "stance", textContent: p.stance + " " });
      const a = Object.assign(document.createElement("a"), {
        href: /^https?:/.test(p.url || "") ? p.url : "#",
        target: "_blank",
        rel: "noopener",
        textContent: `${p.title} (${p.year ?? "n.d."})`,
      });
      const note = document.createElement("div");
      note.textContent = [p.note, p.venue, p.citations != null ? `${p.citations} citations` : ""].filter(Boolean).join(" · ");
      li.append(st, a, note);
      ul.appendChild(li);
    }
    if (!evidence.length) el.querySelector(".evidence").hidden = true;
    $("results").appendChild(el);
  }
}

async function highlightOnPage() {
  if (!current.tabId) return;
  const items = current.claims.map((c) => ({ id: c.id, quote: c.quote, verdict: c.verdict, summary: c.summary }));
  try {
    const found = await toPage(current.tabId, { type: "highlight", items });
    current.claims.forEach((c) => (c.found = !!found?.[c.id]));
  } catch {
    /* page doesn't allow scripts (chrome:// pages, Web Store) */
  }
}

async function finishPage(data) {
  current.claims = data.claims.map((c, i) => ({ id: i + 1, ...c }));
  await highlightOnPage();
  render({ ...data, claims: current.claims }, "page");
}

// ---------- actions ----------
async function checkPage() {
  const tab = await activeTab();
  current.tabId = tab.id;
  await run("Reading the page...", async () => {
    const { s, models } = await getModels();
    let page;
    try {
      page = await toPage(tab.id, { type: "getPage" });
    } catch {
      throw new Error("This page can't be read (browser pages and the Web Store are off-limits).");
    }
    if (!page?.text || page.text.length < 50) throw new Error("Couldn't find readable text on this page.");
    const data = await runText(models, page, { n: +s.maxClaims || 5, keys: searchKeys(s), onProgress: progress });
    await finishPage(data);
  });
}

async function checkVideo() {
  const tab = await activeTab();
  current.tabId = tab.id;
  await run("Looking for captions...", async () => {
    const { s, models } = await getModels();
    const page = await toPage(tab.id, { type: "getPage" });
    const captions = await toPage(tab.id, { type: "getCaptions" });
    let segments, method;
    if (captions?.segments?.length) {
      segments = captions.segments;
      method = "captions";
    } else if (page.video?.mediaSrc && s.provider === "openai") {
      setBusy("No captions. Downloading the video to transcribe with your OpenAI key...");
      const blob = await fetchMedia(page.video.mediaSrc);
      setBusy("Transcribing with OpenAI...");
      segments = await transcribeWithOpenAI(blob, "video.mp4", s.llmKey);
      method = "OpenAI speech-to-text";
    } else if (page.video?.isYouTube) {
      throw new Error(
        "Couldn't get a transcript for this YouTube video. Check that it has captions (the CC button) " +
          "and that the page has finished loading, then try again."
      );
    } else if (page.video?.mediaSrc) {
      throw new Error("This video has no captions. Transcribing it needs an OpenAI key (switch provider in settings).");
    } else {
      throw new Error(
        "This video has no captions the extension can read, and it streams in a way that can't be downloaded. " +
          "If you have the file, upload it below (OpenAI key needed)."
      );
    }
    const data = await checkTranscript(models, segments, {
      title: page.title, n: 8, keys: searchKeys(s), method, onProgress: progress,
    });
    render(data, "video");
  });
}

async function checkUpload(file) {
  current.tabId = null;
  await run(`Reading ${file.name}...`, async () => {
    const { s, models } = await getModels();
    if (s.provider !== "openai")
      throw new Error("Transcribing files needs an OpenAI key. Switch the provider to OpenAI in settings.");
    setBusy("Transcribing with OpenAI...");
    const segments = await transcribeWithOpenAI(file, file.name, s.llmKey);
    const data = await checkTranscript(models, segments, {
      title: file.name, n: 8, keys: searchKeys(s), method: "OpenAI speech-to-text", onProgress: progress,
    });
    render(data, "upload");
  });
  $("upload").value = "";
}

async function checkText(text) {
  const tab = await activeTab();
  current.tabId = tab?.id || null;
  await run("Checking text...", async () => {
    if (text.trim().length < 20) throw new Error("Enter at least a sentence.");
    const { s, models } = await getModels();
    const data = await runText(models, { text, title: "" }, { n: +s.maxClaims || 5, keys: searchKeys(s), onProgress: progress });
    await finishPage(data);
  });
}

// ---------- wiring ----------
$("check-page").onclick = checkPage;
$("check-video").onclick = checkVideo;
$("check-text").onclick = () => checkText($("custom-text").value);
$("upload").onchange = (e) => e.target.files[0] && checkUpload(e.target.files[0]);
$("open-options").onclick = openSettings;

async function refreshVideoButton() {
  try {
    const tab = await activeTab();
    const video = await toPage(tab.id, { type: "videoInfo" }); // checks for a video only; reads no text
    $("check-video").hidden = !video?.hasVideo;
  } catch {
    $("check-video").hidden = true;
  }
}
chrome.tabs.onActivated.addListener(refreshVideoButton);
chrome.tabs.onUpdated.addListener((_id, info) => info.status === "complete" && refreshVideoButton());
chrome.storage.onChanged.addListener((changes) => (changes.llmKey || changes.provider || changes.openalexKey) && refreshBanner());

// Right-click → "Fact-check selected text"
async function takePendingSelection() {
  const { pendingSelection } = await chrome.storage.session.get("pendingSelection");
  if (!pendingSelection || Date.now() - pendingSelection.at > 60000) return;
  await chrome.storage.session.remove("pendingSelection");
  $("custom-text").value = pendingSelection.text;
  $("custom-text").closest("details").open = true;
  checkText(pendingSelection.text);
}
chrome.storage.session.onChanged.addListener((c) => c.pendingSelection?.newValue && takePendingSelection());

migrate();
cachePrune();
refreshBanner();
refreshVideoButton();
takePendingSelection();

// exposed for tests
window.__fc = { refreshVideoButton };
