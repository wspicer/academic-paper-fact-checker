# Science Fact Checker

Fact-check claims on any web page or video against published research
(OpenAlex + Semantic Scholar). Users bring their own Anthropic or OpenAI key.

```
extension/   Chrome extension (side panel): check page, check video, upload file, check selection
backend/     FastAPI server the extension talks to
web/         Optional standalone Streamlit app for single claims
```

## How it works
**Web pages:** the extension reads the article text → the AI picks out the most
check-worthy research claims (with exact quotes) → each claim is checked: search queries →
OpenAlex + Semantic Scholar → drop retracted papers → rerank → AI verdict →
claims are highlighted on the page in green / red / amber / grey.

**Videos**, in order of preference:
1. Captions read in the browser: YouTube caption tracks, or `<track>` captions on any HTML5 video
2. Server fetches captions with yt-dlp (works for most video sites)
3. No captions → server downloads the audio and transcribes it (the user's OpenAI key if they
   have one, otherwise local Whisper)
4. Or upload a video/audio file directly

Right-click any selected text → **Fact-check selected text**.

## Who pays for the AI
| Mode | How |
|---|---|
| **Bring your own key** | User picks Anthropic or OpenAI in the extension settings and pastes a key. It's stored only in their browser (not synced), sent with each request, used for that request only, never stored or logged by the server. |
| **Free tier (optional)** | If the server has `ANTHROPIC_API_KEY`, users without a key get `FREE_CHECKS_PER_DAY` checks (default 3) per install and per IP, with a global daily cap `FREE_CHECKS_GLOBAL_PER_DAY` (default 200). Leave `ANTHROPIC_API_KEY` blank to require users' own keys. |

Default models: `claude-sonnet-5-5` and `gpt-5.6-sol` (users can override in settings;
server defaults via `ANTHROPIC_MODEL` / `OPENAI_MODEL`). Verdicts are cached per claim and
model, so a claim checked once is free for the next user.

## 1. Run the server
Needs Python 3.11+ and ffmpeg (`brew install ffmpeg`).
```
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # add OPENALEX_API_KEY; the rest is optional
set -a; source .env; set +a
uvicorn server:app --port 8000
```
Check http://localhost:8000/status.

## 2. Load the extension
1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → the `extension/` folder
2. The settings page opens: choose Anthropic or OpenAI, paste your key, click **Test key**
3. Under **Server**, the URL is `http://localhost:8000` for a local server
4. Open any article → click the extension icon → **Check this page**

## 3. Publish it
1. **Host the server** (Render, Railway, Fly.io) with `backend/Dockerfile`; set env vars there.
   Use HTTPS. Users' keys pass through it.
2. In `extension/settings.js`, change the default `backendUrl` to your hosted URL.
3. **Chrome Web Store:** register as a developer, zip the *contents* of `extension/`, upload,
   and fill in the listing, permission reasons, and privacy disclosures. Your privacy policy
   should say: page text, video links and the user's API key are sent to your server for the
   check; keys are not stored; results are cached without any user info.
4. Set a monthly spend limit in the Anthropic console if you fund a free tier.

## Known limits
- Only claims that research can test (health, science, etc.); news and politics are skipped.
- Verdicts come from abstracts, not full papers.
- YouTube often blocks downloads from cloud servers, which is why captions are read in the
  browser first. Videos without captions work best with the server on your own computer.
- Local Whisper on CPU takes roughly 0.3-1× the video length; an OpenAI key is much faster.
- Free-tier limits are per install ID and IP. A determined user can get around them, but
  the global daily cap still bounds your cost.
