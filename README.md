# Academic Paper Fact Checker

A Chrome extension that fact-checks claims on any web page or video against published research,
using a retrieval-augmented generation (RAG) pipeline that runs **entirely in the browser**.
Users bring their own Anthropic or OpenAI key, which goes straight to that provider. There is no
backend server.

## How it works
```
page text / video captions / uploaded audio
        │
        ▼
 1. Claim extraction (LLM): the most check-worthy research claims, with exact quotes and timestamps
        │  for each claim, 3 at a time:
        ▼
 2. Query rewriting (LLM): claim → 2 academic search queries
 3. Retrieval: OpenAlex + Semantic Scholar, in parallel
 4. Dedupe by DOI, drop retracted papers (OpenAlex retraction flag)
 5. Rerank: BM25 over title + abstract, with a small citation-count boost → top 8
 6. Grounded verdict (LLM): supported / contradicted / mixed / insufficient evidence,
    using ONLY the retrieved abstracts, with per-paper stance and caveats
        │
        ▼
 Results in the side panel; claims highlighted on the page or linked to video timestamps
```

**Videos:** captions are read in the browser (YouTube caption tracks or HTML5 `<track>`
captions). Without captions, a direct video file or an uploaded file up to 25 MB is transcribed
with the user's OpenAI key.

**Caching:** verdicts are cached on the user's device for 7 days, keyed by claim + model + mode.

**Economy mode (default on):** a small model (Claude Haiku 5.5 / GPT-5.6 Luna) extracts claims
*and* writes their search queries in one call; the main model (Claude Sonnet 5.5 / GPT-5.6 Sol)
only judges evidence. Pages are capped at 20k characters and verdicts see the top 5 papers with
shorter abstracts. In tests this cut AI calls per 2-claim page from 5 to 3 and input text by 64%,
with the biggest step moved to the cheap model.

| | Full | Economy |
|---|---|---|
| Claim extraction | main model, 60k chars | fast model, 20k chars, also writes queries |
| Query rewriting | 1 call per claim (main) | merged into extraction |
| Verdict | main model, top 8 papers × 1,500 chars | main model, top 5 papers × 800 chars |

## Code
```
extension/
  manifest.json        Manifest V3
  background.js        side panel + right-click menu
  content.js           reads pages and captions, highlights claims, seeks video
  sidepanel.*          UI
  options.*            settings (keys stored in chrome.storage.local)
  lib/llm.js           Anthropic + OpenAI clients (key only ever sent to the provider's host)
  lib/search.js        OpenAlex + Semantic Scholar retrieval, dedupe
  lib/rerank.js        BM25 reranker
  lib/pipeline.js      claim extraction, query rewriting, verdict, orchestration
  lib/transcribe.js    OpenAI speech-to-text
  lib/cache.js         on-device result cache
```

## Install (development)
1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose `extension/`
2. In settings, choose Anthropic or OpenAI, paste your key, click **Test key**
3. Add a free OpenAlex key (openalex.org/settings/api); without one, OpenAlex allows only a few searches a day
4. Open an article → click the extension icon → **Check this page**

## Publish to the Chrome Web Store
1. Register as a Chrome Web Store developer (one-time fee)
2. Zip the **contents** of `extension/` and upload it
3. Listing: description, screenshots, the 128 px icon in `extension/icons/`
4. Privacy: link to `PRIVACY.md` (e.g. its GitHub URL) and declare that the extension sends
   user-selected website content to the user's chosen AI provider. Justify the "all sites"
   permission: it reads the page the user asks to check

## Security model
- Keys live in `chrome.storage.local` (this browser, never synced) and are only sent to
  `api.anthropic.com` or `api.openai.com`; `lib/llm.js` refuses any other host.
- Web pages can't read extension storage, so a malicious page can't take the key. Page text is
  passed to the model as untrusted data, with instructions to ignore commands inside it.
- Users are advised to create a dedicated key with a spend limit.

## Limits
- Only claims research can test (health, science, etc.); news and politics are skipped.
- Verdicts come from abstracts, not full papers.
- Streaming videos without captions (most big platforms) can't be downloaded in the browser;
  upload the file instead.
- Cost is on the user's key: about 1 + 2×(claims) AI calls per page.
