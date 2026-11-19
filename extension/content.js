// Injected on demand by the side panel. Reads the page, finds videos/captions,
// highlights claims, and seeks videos to a timestamp.
(() => {
  if (window.__fcLoaded) return;
  window.__fcLoaded = true;

  const MAX_CHARS = 60000;
  const STYLE_ID = "fc-style";

  // ---------- page text ----------
  function extractMainText() {
    const root =
      document.querySelector("article") ||
      document.querySelector("main, [role=main]") ||
      document.body;
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll("script,style,noscript,nav,footer,header,aside,form,iframe,svg,button,[aria-hidden=true]")
      .forEach((el) => el.remove());
    // innerText needs layout; textContent is a fallback for detached clones.
    const text = (clone.innerText || clone.textContent || "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text.slice(0, MAX_CHARS);
  }

  // ---------- videos ----------
  function mainVideo() {
    const vids = [...document.querySelectorAll("video")];
    if (!vids.length) return null;
    return vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  }

  function isYouTube() {
    return /(^|\.)youtube\.com$/.test(location.hostname) && /\/(watch|shorts|live)/.test(location.pathname);
  }

  function videoInfo() {
    const v = mainVideo();
    const src = v ? v.currentSrc || v.src || "" : "";
    return {
      hasVideo: !!v || isYouTube(),
      isYouTube: isYouTube(),
      // blob: URLs (streaming players) can't be fetched by the server; use the page URL.
      // Direct file URL we can download for transcription (not blob:/streaming players).
      mediaSrc: !isYouTube() && /^https?:/.test(src) ? src : null,
      duration: v && isFinite(v.duration) ? v.duration : null,
    };
  }

  // Captions from <track> elements already loaded in an HTML5 player.
  function trackCaptions() {
    const v = mainVideo();
    if (!v || !v.textTracks) return null;
    for (const track of v.textTracks) {
      if (!["captions", "subtitles"].includes(track.kind)) continue;
      if (track.mode === "disabled") track.mode = "hidden"; // forces cues to load
      const cues = track.cues ? [...track.cues] : [];
      if (cues.length) {
        return cues.map((c) => ({ start: c.startTime, text: c.text.replace(/<[^>]+>/g, "") }));
      }
    }
    return null;
  }

  // YouTube captions, read in the browser (avoids YouTube blocking server IPs).
  async function youTubeCaptions() {
    try {
      const html = await (await fetch(location.href, { credentials: "include" })).text();
      const m = html.match(/"captionTracks":(\[.*?\])/);
      if (!m) return null;
      const tracks = JSON.parse(m[1]);
      const pick =
        tracks.find((t) => t.languageCode === "en" && t.kind !== "asr") ||
        tracks.find((t) => t.languageCode?.startsWith("en")) ||
        tracks[0];
      if (!pick) return null;
      const url = pick.baseUrl.replace(/\\u0026/g, "&") + "&fmt=json3";
      const data = await (await fetch(url, { credentials: "include" })).json();
      const segs = (data.events || [])
        .filter((e) => e.segs)
        .map((e) => ({
          start: (e.tStartMs || 0) / 1000,
          text: e.segs.map((s) => s.utf8).join("").replace(/\n/g, " ").trim(),
        }))
        .filter((s) => s.text);
      return segs.length ? segs : null;
    } catch (e) {
      return null;
    }
  }

  async function getCaptions() {
    if (isYouTube()) {
      const yt = await youTubeCaptions();
      if (yt) return { segments: yt, method: "youtube-captions" };
    }
    const tc = trackCaptions();
    if (tc) return { segments: tc, method: "track-captions" };
    return null;
  }

  function seek(seconds) {
    const v = mainVideo();
    if (!v) return false;
    v.currentTime = seconds;
    v.scrollIntoView({ behavior: "smooth", block: "center" });
    v.play().catch(() => {});
    return true;
  }

  // ---------- highlighting ----------
  const COLORS = {
    supported: "#c8f7c5",
    contradicted: "#ffc9c9",
    mixed: "#ffe3a3",
    "insufficient evidence": "#e2e2e2",
    error: "#e2e2e2",
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `.fc-mark{border-radius:3px;padding:0 2px;cursor:help;color:inherit}
      .fc-mark.fc-flash{outline:3px solid #4a6cf7;transition:outline .3s}`;
    document.head.appendChild(s);
  }

  function clearHighlights() {
    document.querySelectorAll("mark.fc-mark").forEach((m) => {
      m.replaceWith(...m.childNodes);
    });
    document.body.normalize();
  }

  // window.find matches across element boundaries, which plain text search can't.
  function findRange(quote) {
    const sel = window.getSelection();
    const tries = [quote, quote.split(/\s+/).slice(0, 10).join(" "), quote.split(/\s+/).slice(0, 6).join(" ")];
    for (const q of tries) {
      if (!q || q.length < 12) continue;
      sel.removeAllRanges();
      // find(string, caseSensitive, backwards, wrapAround, wholeWord, searchInFrames)
      if (window.find(q, false, false, true, false, false)) {
        const range = sel.getRangeAt(0).cloneRange();
        sel.removeAllRanges();
        return range;
      }
    }
    sel.removeAllRanges();
    return null;
  }

  function highlight(items) {
    ensureStyle();
    clearHighlights();
    const found = {};
    const scrollPos = [window.scrollX, window.scrollY];
    for (const { id, quote, verdict, summary } of items) {
      if (!quote) continue;
      const range = findRange(quote);
      if (!range) continue;
      const mark = document.createElement("mark");
      mark.className = "fc-mark";
      mark.dataset.fcId = id;
      mark.style.background = COLORS[verdict] || COLORS.error;
      mark.title = `${(verdict || "").toUpperCase()}: ${summary || ""}`;
      try {
        mark.appendChild(range.extractContents());
        range.insertNode(mark);
        found[id] = true;
      } catch (e) {
        /* skip ranges that can't be wrapped */
      }
    }
    window.scrollTo(...scrollPos); // window.find scrolls; put the reader back
    return found;
  }

  function scrollToClaim(id) {
    const m = document.querySelector(`mark.fc-mark[data-fc-id="${CSS.escape(String(id))}"]`);
    if (!m) return false;
    m.scrollIntoView({ behavior: "smooth", block: "center" });
    m.classList.add("fc-flash");
    setTimeout(() => m.classList.remove("fc-flash"), 1500);
    return true;
  }

  // ---------- messages from the side panel ----------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    (async () => {
      switch (msg.type) {
        case "getPage":
          return { title: document.title, url: location.href, text: extractMainText(), video: videoInfo() };
        case "getCaptions":
          return await getCaptions();
        case "highlight":
          return highlight(msg.items || []);
        case "clear":
          return clearHighlights();
        case "scrollTo":
          return scrollToClaim(msg.id);
        case "seek":
          return seek(msg.seconds);
      }
    })().then(reply, (e) => reply({ error: String(e) }));
    return true; // async reply
  });

  // Exposed for tests.
  window.__fc = { extractMainText, highlight, clearHighlights, videoInfo, trackCaptions };
})();
