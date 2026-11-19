const $ = (id) => document.getElementById(id);
const DEFAULTS = { backendUrl: "http://localhost:8000", apiToken: "", maxClaims: 5 };

let current = { tabId: null, mode: null, claims: [] };

// ---------- helpers ----------
async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function toPage(tabId, msg) {
  await inject(tabId);
  return chrome.tabs.sendMessage(tabId, msg);
}

async function api(path, { json, form } = {}) {
  const { backendUrl, apiToken } = await settings();
  const headers = apiToken ? { "X-API-Token": apiToken } : {};
  let body;
  if (json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else body = form;
  let res;
  try {
    res = await fetch(backendUrl.replace(/\/$/, "") + path, { method: "POST", headers, body });
  } catch (e) {
    throw new Error(`Can't reach the fact-check server at ${backendUrl}. Is it running? (Settings ⚙️)`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Server error ${res.status}`);
  return data;
}

function setBusy(msg) {
  $("status").hidden = !msg;
  $("status").textContent = msg || "";
  document.querySelectorAll("#actions button, #upload").forEach((b) => (b.disabled = !!msg));
}

function showError(msg) {
  $("error").hidden = !msg;
  $("error").textContent = msg || "";
}

function fmtTime(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
}

async function run(label, fn) {
  showError("");
  $("results").innerHTML = "";
  $("meta").hidden = true;
  setBusy(label);
  try {
    await fn();
  } catch (e) {
    showError(e.message || String(e));
  } finally {
    setBusy("");
  }
}

// ---------- rendering ----------
function render(data, mode) {
  current.mode = mode;
  current.claims = data.claims.map((c, i) => ({ id: i + 1, ...c }));
  $("results").innerHTML = "";
  const n = current.claims.length;
  $("meta").hidden = false;
  $("meta").textContent = n
    ? `${n} claim${n > 1 ? "s" : ""} checked in ${data.seconds}s` +
      (data.transcript_method ? ` · transcript from ${data.transcript_method}` : "")
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
    const cav = el.querySelector(".caveats");
    (c.caveats || []).forEach((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      cav.appendChild(li);
    });

    const jump = el.querySelector(".jump");
    if (mode === "video" && c.timestamp != null) {
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
      const st = document.createElement("span");
      st.className = "stance";
      st.textContent = p.stance + " ";
      const a = document.createElement("a");
      a.href = p.url || "#";
      a.target = "_blank";
      a.textContent = `${p.title} (${p.year ?? "n.d."})`;
      const note = document.createElement("div");
      note.textContent = [p.note, p.venue, p.citations != null ? `${p.citations} citations` : ""]
        .filter(Boolean)
        .join(" · ");
      li.append(st, a, note);
      ul.appendChild(li);
    }
    if (!evidence.length) el.querySelector(".evidence").hidden = true;
    $("results").appendChild(el);
  }
}

async function highlightOnPage() {
  const items = current.claims.map((c) => ({ id: c.id, quote: c.quote, verdict: c.verdict, summary: c.summary }));
  try {
    const found = await toPage(current.tabId, { type: "highlight", items });
    current.claims.forEach((c) => (c.found = !!found?.[c.id]));
  } catch (e) {
    /* page may not allow scripts (e.g. chrome:// pages) */
  }
}

// ---------- actions ----------
async function checkPage() {
  const tab = await activeTab();
  current.tabId = tab.id;
  await run("Reading the page...", async () => {
    let page;
    try {
      page = await toPage(tab.id, { type: "getPage" });
    } catch (e) {
      throw new Error("This page can't be read (browser pages and the Web Store are off-limits).");
    }
    if (!page?.text || page.text.length < 50) throw new Error("Couldn't find readable text on this page.");
    setBusy("Finding claims and searching research papers... (about 30-60 s)");
    const { maxClaims } = await settings();
    const data = await api("/check/text", { json: { text: page.text, title: page.title, url: page.url, max_claims: +maxClaims } });
    current.claims = data.claims.map((c, i) => ({ ...c, id: i + 1 }));
    await highlightOnPage(); // marks which quotes were found, for "Show on page"
    render({ ...data, claims: current.claims }, "page");
  });
}

async function checkVideo() {
  const tab = await activeTab();
  current.tabId = tab.id;
  await run("Looking for captions...", async () => {
    const page = await toPage(tab.id, { type: "getPage" });
    const captions = await toPage(tab.id, { type: "getCaptions" });
    let data;
    if (captions?.segments?.length) {
      setBusy("Found captions. Finding claims and checking research... (about 1 min)");
      data = await api("/check/transcript", {
        json: { segments: captions.segments, title: page.title, url: page.url, max_claims: 8 },
      });
    } else {
      setBusy("No captions in the page. The server is fetching or transcribing the video... (can take several minutes)");
      data = await api("/check/video", { json: { url: page.video.fetchableUrl, max_claims: 8 } });
    }
    render(data, "video");
  });
}

async function checkUpload(file) {
  current.tabId = null;
  await run(`Uploading ${file.name}...`, async () => {
    const form = new FormData();
    form.append("file", file);
    setBusy("Transcribing and checking... (can take several minutes)");
    const data = await api("/check/upload?max_claims=8", { form });
    render(data, "upload");
  });
}

async function checkText(text) {
  const tab = await activeTab();
  current.tabId = tab?.id;
  await run("Checking text...", async () => {
    if (text.trim().length < 20) throw new Error("Enter at least a sentence.");
    const data = await api("/check/text", { json: { text, max_claims: 5 } });
    current.claims = data.claims.map((c, i) => ({ ...c, id: i + 1 }));
    if (current.tabId) await highlightOnPage();
    render({ ...data, claims: current.claims }, "page");
  });
}

// ---------- wiring ----------
$("check-page").onclick = checkPage;
$("check-video").onclick = checkVideo;
$("check-text").onclick = () => checkText($("custom-text").value);
$("upload").onchange = (e) => e.target.files[0] && checkUpload(e.target.files[0]);
$("open-options").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

async function refreshVideoButton() {
  const tab = await activeTab();
  try {
    const page = await toPage(tab.id, { type: "getPage" });
    $("check-video").hidden = !page?.video?.hasVideo;
  } catch {
    $("check-video").hidden = true;
  }
}
chrome.tabs.onActivated.addListener(refreshVideoButton);
chrome.tabs.onUpdated.addListener((_id, info) => info.status === "complete" && refreshVideoButton());
refreshVideoButton();

// Right-click → "Fact-check selected text"
async function takePendingSelection() {
  const { pendingSelection } = await chrome.storage.session.get("pendingSelection");
  if (!pendingSelection || Date.now() - pendingSelection.at > 60000) return;
  await chrome.storage.session.remove("pendingSelection");
  $("custom-text").value = pendingSelection.text;
  $("custom-text").closest("details").open = true;
  checkText(pendingSelection.text);
}
chrome.storage.session.onChanged.addListener((changes) => changes.pendingSelection?.newValue && takePendingSelection());
takePendingSelection();
