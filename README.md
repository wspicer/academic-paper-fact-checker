# Science Fact Checker

Fact-check claims on any web page or video against published research
(OpenAlex + Semantic Scholar), with Claude extracting the claims and weighing the evidence.

```
extension/   Chrome extension (side panel): check page, check video, upload file, check selection
backend/     FastAPI server the extension talks to (holds all API keys)
web/         Optional standalone Streamlit app for single claims
```

## How it works
**Web pages:** the extension reads the main article text → server asks Claude for the most
check-worthy research claims (with exact quotes) → each claim is checked: search queries →
OpenAlex + Semantic Scholar → drop retracted papers → rerank → Claude verdict →
claims are highlighted on the page in green / red / amber / grey.

**Videos**, in order of preference:
1. Captions read in the browser: YouTube caption tracks, or `<track>` captions on any HTML5 video
2. Server fetches captions with yt-dlp (works for most video sites)
3. No captions → server downloads the audio and transcribes it (local Whisper, or OpenAI's API)
4. Or upload a video/audio file directly

Each video claim gets a ▶ timestamp button that jumps the video to that moment.

Right-click any selected text → **Fact-check selected text**.

## 1. Run the server
Needs Python 3.11+ and ffmpeg (`brew install ffmpeg` / `apt install ffmpeg`).
```
cd backend
pip install -r requirements.txt
cp .env.example .env        # fill in keys
set -a; source .env; set +a
uvicorn server:app --port 8000
```
Or with Docker: `docker build -t factcheck backend && docker run --env-file backend/.env -p 8000:8000 factcheck`

## 2. Load the extension
1. Chrome → `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → choose the `extension/` folder
3. Click the extension's ⚙️ → set Server URL (`http://localhost:8000`) and the access token
   (same as `API_TOKEN` in `.env`)
4. Pin it, open any article, click the icon → **Check this page**

## 3. Let others use it
- **Host the server** somewhere public (Render, Railway, Fly.io, a VPS) using the Dockerfile.
  Put the keys in the host's secret settings, never in the extension.
- **Share the extension:** zip the `extension/` folder for friends to load unpacked, or
  publish to the Chrome Web Store (one-time developer fee; needs a privacy policy because
  the extension sends page text to your server).
- **Access control:** everyone shares `API_TOKEN`; each client gets `DAILY_CHECKS_PER_CLIENT`
  requests a day. For a real public launch, replace the shared token with per-user accounts.
- **Cost:** a page check is about 1 + 2×(claims) Claude calls. Set a monthly spend limit in
  the Anthropic console. Results are cached in memory per claim and per video.

## Known limits
- Only claims that research can test (health, science, etc.); news and political events are skipped.
- Verdicts come from abstracts, not full papers.
- YouTube often blocks downloads from cloud servers, which is why captions are read in the
  browser first. Videos without captions work best with the server on your own computer.
- Local Whisper on CPU takes roughly 0.3-1× the video length; `OPENAI_API_KEY` is much faster.
  Videos over `MAX_VIDEO_MINUTES` (default 45) are rejected.
- Paywalled or app-rendered pages without readable text can't be checked; paste the text instead.
- DRM-protected streaming (Netflix, etc.) can't be transcribed.
