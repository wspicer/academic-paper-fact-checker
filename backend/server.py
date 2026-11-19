"""
Fact-check API used by the browser extension.

  POST /check/text        {text, title?, url?, max_claims?}       web page or selection
  POST /check/transcript  {segments:[{start,text}], title?, url?}  captions read in the browser
  POST /check/video       {url}                                    server fetches captions / transcribes
  POST /check/upload      multipart file                           a video/audio file
"""
import os
import shutil
import tempfile
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from functools import lru_cache

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import video
from checker import check_claim
from claims import extract_claims, format_transcript

API_TOKEN = os.environ.get("API_TOKEN")              # shared secret the extension sends
DAILY_LIMIT = int(os.environ.get("DAILY_CHECKS_PER_CLIENT", 30))
MAX_CLAIMS = int(os.environ.get("MAX_CLAIMS", 10))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", 200))

app = FastAPI(title="Science Fact Checker API")
app.add_middleware(CORSMiddleware, allow_origin_regex=r"chrome-extension://.*",
                   allow_methods=["*"], allow_headers=["*"])


def anthropic_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise HTTPException(500, "Server is missing ANTHROPIC_API_KEY.")
    return key


# ---------- auth + rate limit ----------
_usage: dict = defaultdict(int)
_usage_lock = threading.Lock()


def guard(request: Request, x_api_token: str | None = Header(default=None)):
    if API_TOKEN and x_api_token != API_TOKEN:
        raise HTTPException(401, "Missing or wrong API token. Set it in the extension options.")
    client = x_api_token or (request.client.host if request.client else "unknown")
    key = (client, date.today().isoformat())
    with _usage_lock:
        if _usage[key] >= DAILY_LIMIT:
            raise HTTPException(429, f"Daily limit of {DAILY_LIMIT} checks reached.")
        _usage[key] += 1


# ---------- shared pipeline ----------
@lru_cache(maxsize=1024)
def _cached_check(claim: str) -> dict:
    return check_claim(claim, anthropic_key())


def _slim_paper(p: dict) -> dict:
    return {k: p.get(k) for k in ("title", "year", "venue", "citations", "url", "source")} | {
        "abstract": (p.get("abstract") or "")[:500]}


def check_all(claims: list[dict]) -> list[dict]:
    def one(c):
        try:
            data = _cached_check(c["claim"])
            return {**c, **data["result"], "evidence": [_slim_paper(p) for p in data["papers"]],
                    "retracted_excluded": len(data["retracted"])}
        except Exception as e:
            return {**c, "verdict": "error", "summary": f"Check failed: {e}", "evidence": []}
    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(one, claims))


def respond(claims, started, **extra):
    return {"claims": check_all(claims), "seconds": round(time.time() - started, 1), **extra}


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


@app.post("/check/text", dependencies=[Depends(guard)])
def check_text(body: TextIn):
    started = time.time()
    n = max(1, min(body.max_claims, MAX_CLAIMS))
    claims = extract_claims(body.text, anthropic_key(), n=n, title=body.title)
    return respond(claims, started, source="page")


def _check_segments(segments: list[dict], title: str, n: int, started: float, method: str):
    text = format_transcript(segments)
    claims = extract_claims(text, anthropic_key(), n=max(1, min(n, MAX_CLAIMS)),
                            transcript=True, title=title)
    return respond(claims, started, source="video", transcript_method=method, title=title)


@app.post("/check/transcript", dependencies=[Depends(guard)])
def check_transcript(body: TranscriptIn):
    segs = [s.model_dump() for s in body.segments]
    return _check_segments(segs, body.title, body.max_claims, time.time(), "captions (browser)")


@lru_cache(maxsize=64)
def _cached_transcript(url: str) -> dict:
    return video.get_video_transcript(url)


@app.post("/check/video", dependencies=[Depends(guard)])
def check_video(body: VideoIn):
    started = time.time()
    if not body.url.startswith(("http://", "https://")):
        raise HTTPException(400, "That video can't be fetched by URL. Try uploading the file.")
    try:
        t = _cached_transcript(body.url)
    except video.VideoError as e:
        raise HTTPException(422, str(e))
    return _check_segments(t["segments"], t["title"], body.max_claims, started, t["method"])


@app.post("/check/upload", dependencies=[Depends(guard)])
def check_upload(file: UploadFile = File(...), max_claims: int = 8):
    started = time.time()
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "upload" + os.path.splitext(file.filename or "")[1])
        with open(path, "wb") as out:
            shutil.copyfileobj(file.file, out)
        if os.path.getsize(path) > MAX_UPLOAD_MB * 1024 * 1024:
            raise HTTPException(413, f"File is over {MAX_UPLOAD_MB} MB.")
        try:
            segments = video.transcribe(path)
        except video.VideoError as e:
            raise HTTPException(422, str(e))
    if not segments:
        raise HTTPException(422, "No speech was detected in that file.")
    return _check_segments(segments, file.filename or "", max_claims, started, "speech-to-text")
