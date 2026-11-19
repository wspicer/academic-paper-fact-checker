"""
Fact-check API used by the browser extension.

Who pays for the language model:
  * Bring your own key: the extension sends X-LLM-Provider (anthropic|openai), X-LLM-Key and
    optionally X-LLM-Model. The key is used for that request only and never stored or logged.
  * Free tier (optional): with no user key, the server's ANTHROPIC_API_KEY is used for
    FREE_CHECKS_PER_DAY checks per install and per IP, under a global daily cap.

  POST /check/key         test the user's key
  POST /check/text        {text, title?, url?, max_claims?}       web page or selection
  POST /check/transcript  {segments:[{start,text}], title?, url?}  captions read in the browser
  POST /check/video       {url}                                    server fetches captions / transcribes
  POST /check/upload      multipart file                           a video/audio file
  GET  /status            what this server offers (free tier left, defaults)
"""
import os
import shutil
import tempfile
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date
from functools import lru_cache

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import video
from checker import check_claim
from claims import extract_claims, format_transcript
from llm import DEFAULT_MODELS, LLM, LLMAuthError, LLMError, PROVIDERS, call_llm


def env_int(name, default):
    return int(os.environ.get(name) or default)


API_TOKEN = os.environ.get("API_TOKEN")              # optional: makes the server private
SERVER_KEY = os.environ.get("ANTHROPIC_API_KEY")     # optional: funds the free tier
FREE_PER_CLIENT = env_int("FREE_CHECKS_PER_DAY", 3)
FREE_GLOBAL = env_int("FREE_CHECKS_GLOBAL_PER_DAY", 200)   # cost backstop across all users
BYOK_PER_CLIENT = env_int("BYOK_CHECKS_PER_DAY", 300)      # protects server CPU/bandwidth
MAX_CLAIMS = env_int("MAX_CLAIMS", 10)
MAX_UPLOAD_MB = env_int("MAX_UPLOAD_MB", 200)

app = FastAPI(title="Science Fact Checker API")
app.add_middleware(CORSMiddleware, allow_origin_regex=r"chrome-extension://.*",
                   allow_methods=["*"], allow_headers=["*"])


# ---------- usage counters ----------
_usage: dict = defaultdict(int)
_usage_lock = threading.Lock()


def _today():
    return date.today().isoformat()


def _take(keys: list[tuple], limits: list[int]) -> bool:
    """Atomically increment every counter if all are under their limit."""
    with _usage_lock:
        if any(_usage[k] >= lim for k, lim in zip(keys, limits)):
            return False
        for k in keys:
            _usage[k] += 1
        return True


def free_left(install_id: str, ip: str) -> int:
    with _usage_lock:
        d = _today()
        return max(0, min(FREE_PER_CLIENT - _usage[("free", "id", install_id, d)],
                          FREE_PER_CLIENT - _usage[("free", "ip", ip, d)],
                          FREE_GLOBAL - _usage[("free", "all", d)]))


# ---------- who pays: resolve the LLM for each request ----------
@dataclass
class Billing:
    llm: LLM
    mode: str           # "own-key" | "free"
    free_left: int | None = None

    @property
    def openai_key(self):
        return self.llm.key if self.llm.provider == "openai" else None


def billing(request: Request,
            x_api_token: str | None = Header(default=None),
            x_llm_provider: str | None = Header(default=None),
            x_llm_key: str | None = Header(default=None),
            x_llm_model: str | None = Header(default=None),
            x_install_id: str | None = Header(default=None)) -> Billing:
    if API_TOKEN and x_api_token != API_TOKEN:
        raise HTTPException(401, "This server is private: missing or wrong access token.")
    ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or \
        (request.client.host if request.client else "unknown")
    install = (x_install_id or "none")[:64]
    d = _today()

    if x_llm_key:
        provider = (x_llm_provider or "anthropic").lower()
        if provider not in PROVIDERS:
            raise HTTPException(400, f"Unknown provider '{provider}'.")
        if not _take([("byok", install, d), ("byok-ip", ip, d)], [BYOK_PER_CLIENT, BYOK_PER_CLIENT * 3]):
            raise HTTPException(429, f"Daily limit of {BYOK_PER_CLIENT} checks reached on this server.")
        return Billing(LLM(provider, x_llm_key.strip(), (x_llm_model or "").strip()), "own-key")

    if SERVER_KEY and FREE_PER_CLIENT > 0:
        keys = [("free", "id", install, d), ("free", "ip", ip, d), ("free", "all", d)]
        if not _take(keys, [FREE_PER_CLIENT, FREE_PER_CLIENT, FREE_GLOBAL]):
            raise HTTPException(402, "You've used today's free checks. Add your own Anthropic or "
                                     "OpenAI API key in the extension settings to keep going.")
        return Billing(LLM("anthropic", SERVER_KEY), "free", free_left(install, ip))

    raise HTTPException(402, "Add your Anthropic or OpenAI API key in the extension settings.")


# ---------- shared pipeline ----------
_check_cache: dict = {}
_check_lock = threading.Lock()


def _cached_check(claim: str, llm: LLM) -> dict:
    # Keyed by claim + provider/model, never by API key: a cached verdict is reused across users.
    key = (claim.strip().lower(), llm.provider, llm.model)
    with _check_lock:
        if key in _check_cache:
            return _check_cache[key]
    result = check_claim(claim, llm)
    with _check_lock:
        if len(_check_cache) > 2000:
            _check_cache.clear()
        _check_cache[key] = result
    return result


def _slim_paper(p: dict) -> dict:
    return {k: p.get(k) for k in ("title", "year", "venue", "citations", "url", "source")} | {
        "abstract": (p.get("abstract") or "")[:500]}


def check_all(claims: list[dict], llm: LLM) -> list[dict]:
    def one(c):
        try:
            data = _cached_check(c["claim"], llm)
            return {**c, **data["result"], "evidence": [_slim_paper(p) for p in data["papers"]],
                    "retracted_excluded": len(data["retracted"])}
        except LLMError:
            raise                       # bad key / no credit: fail the whole request clearly
        except Exception as e:
            return {**c, "verdict": "error", "summary": f"Check failed: {e}", "evidence": []}
    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(one, claims))


def respond(claims, b: Billing, started, **extra):
    return {"claims": check_all(claims, b.llm), "seconds": round(time.time() - started, 1),
            "billing": b.mode, "model": b.llm.label, "free_checks_left": b.free_left, **extra}


@app.exception_handler(LLMError)
def llm_error(_request, exc: LLMError):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=401 if isinstance(exc, LLMAuthError) else 400,
                        content={"detail": str(exc)})


# ---------- endpoints ----------
class TextIn(BaseModel):
    text: str = Field(..., min_length=20, max_length=400_000)
    title: str = ""
    url: str = ""
    max_claims: int = 5


class Segment(BaseModel):
    start: float
    text: str


class TranscriptIn(BaseModel):
    segments: list[Segment] = Field(..., min_length=1)
    title: str = ""
    url: str = ""
    max_claims: int = 8


class VideoIn(BaseModel):
    url: str
    max_claims: int = 8


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/status")
def status(request: Request, x_install_id: str | None = Header(default=None)):
    ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or \
        (request.client.host if request.client else "unknown")
    free = bool(SERVER_KEY and FREE_PER_CLIENT > 0)
    return {"free_tier": free,
            "free_checks_left": free_left((x_install_id or "none")[:64], ip) if free else 0,
            "default_models": DEFAULT_MODELS, "private": bool(API_TOKEN)}


@app.post("/check/key")
def check_key(x_llm_provider: str | None = Header(default=None),
              x_llm_key: str | None = Header(default=None),
              x_llm_model: str | None = Header(default=None),
              x_api_token: str | None = Header(default=None)):
    if API_TOKEN and x_api_token != API_TOKEN:
        raise HTTPException(401, "This server is private: missing or wrong access token.")
    if not x_llm_key:
        raise HTTPException(400, "No key provided.")
    llm = LLM((x_llm_provider or "anthropic").lower(), x_llm_key.strip(), (x_llm_model or "").strip())
    call_llm(llm, 'Reply with the JSON {"ok": true}.', "ping", max_tokens=20)
    return {"ok": True, "model": llm.label}


@app.post("/check/text")
def check_text(body: TextIn, b: Billing = Depends(billing)):
    started = time.time()
    n = max(1, min(body.max_claims, MAX_CLAIMS))
    claims = extract_claims(body.text, b.llm, n=n, title=body.title)
    return respond(claims, b, started, source="page")


def _check_segments(segments, title, n, b: Billing, started, method):
    text = format_transcript(segments)
    claims = extract_claims(text, b.llm, n=max(1, min(n, MAX_CLAIMS)), transcript=True, title=title)
    return respond(claims, b, started, source="video", transcript_method=method, title=title)


@app.post("/check/transcript")
def check_transcript(body: TranscriptIn, b: Billing = Depends(billing)):
    segs = [s.model_dump() for s in body.segments]
    return _check_segments(segs, body.title, body.max_claims, b, time.time(), "captions (browser)")


_transcripts: dict = {}


def _transcript(url: str, openai_key: str | None) -> dict:
    if url not in _transcripts:
        if len(_transcripts) > 64:
            _transcripts.clear()
        _transcripts[url] = video.get_video_transcript(url, openai_key)
    return _transcripts[url]


@app.post("/check/video")
def check_video(body: VideoIn, b: Billing = Depends(billing)):
    started = time.time()
    if not body.url.startswith(("http://", "https://")):
        raise HTTPException(400, "That video can't be fetched by URL. Try uploading the file.")
    try:
        t = _transcript(body.url, b.openai_key)
    except video.VideoError as e:
        raise HTTPException(422, str(e))
    return _check_segments(t["segments"], t["title"], body.max_claims, b, started, t["method"])


@app.post("/check/upload")
def check_upload(file: UploadFile = File(...), max_claims: int = 8, b: Billing = Depends(billing)):
    started = time.time()
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "upload" + os.path.splitext(file.filename or "")[1])
        with open(path, "wb") as out:
            shutil.copyfileobj(file.file, out)
        if os.path.getsize(path) > MAX_UPLOAD_MB * 1024 * 1024:
            raise HTTPException(413, f"File is over {MAX_UPLOAD_MB} MB.")
        try:
            segments = video.transcribe(path, b.openai_key)
        except video.VideoError as e:
            raise HTTPException(422, str(e))
    if not segments:
        raise HTTPException(422, "No speech was detected in that file.")
    return _check_segments(segments, file.filename or "", max_claims, b, started, "speech-to-text")
