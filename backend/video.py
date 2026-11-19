"""Get a transcript for a video: captions first, speech-to-text as a fallback."""
import os
import re
import subprocess
import tempfile
from pathlib import Path

import requests

MAX_VIDEO_MINUTES = int(os.environ.get("MAX_VIDEO_MINUTES", 45))
WHISPER_LOCAL_MODEL = os.environ.get("WHISPER_MODEL", "base")
OPENAI_LIMIT_BYTES = 24 * 1024 * 1024


class VideoError(Exception):
    pass


# ---------- captions ----------
_TS = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})")


def _ts_to_seconds(ts: str) -> float:
    m = _TS.search(ts)
    if not m:
        return 0.0
    h, mi, s, ms = m.groups()
    return int(h or 0) * 3600 + int(mi) * 60 + int(s) + int(ms) / 1000


def parse_vtt(text: str) -> list[dict]:
    """Parse WebVTT/SRT. Handles YouTube auto-captions, which repeat the previous line."""
    segments, prev_lines = [], set()
    blocks = re.split(r"\n\s*\n", text.replace("\r", ""))
    for block in blocks:
        lines = block.strip().split("\n")
        idx = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if idx is None:
            continue
        start = _ts_to_seconds(lines[idx].split("-->")[0])
        cue_lines = []
        for l in lines[idx + 1:]:
            clean = re.sub(r"<[^>]+>", "", l).replace("&nbsp;", " ").replace("&amp;", "&").strip()
            if clean:
                cue_lines.append(clean)
        new = [l for l in cue_lines if l not in prev_lines]
        prev_lines = set(cue_lines)
        if new:
            segments.append({"start": start, "text": " ".join(new)})
    return segments


def _pick_lang(tracks: dict, lang: str) -> list:
    keys = sorted(tracks, key=lambda k: (k != lang, not k.startswith(lang), k))
    return [tracks[k] for k in keys if k.startswith(lang)]


def fetch_captions(url: str, lang: str = "en") -> tuple[list[dict] | None, dict]:
    import yt_dlp
    opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        raise VideoError(f"Couldn't open that video: {e}") from e
    for source in (info.get("subtitles") or {}, info.get("automatic_captions") or {}):
        for formats in _pick_lang(source, lang):
            for f in formats:
                if f.get("ext") not in ("vtt", "srt"):
                    continue
                try:
                    r = requests.get(f["url"], timeout=30)
                    r.raise_for_status()
                    segs = parse_vtt(r.text)
                    if segs:
                        return segs, info
                except Exception:
                    continue
    return None, info


# ---------- speech-to-text ----------
def download_audio(url: str, info: dict, tmpdir: str) -> str:
    duration = info.get("duration") or 0
    if duration and duration > MAX_VIDEO_MINUTES * 60:
        raise VideoError(f"Video is {duration // 60} min; the limit for transcription is "
                         f"{MAX_VIDEO_MINUTES} min.")
    import yt_dlp
    opts = {"quiet": True, "no_warnings": True, "format": "bestaudio/best",
            "outtmpl": os.path.join(tmpdir, "audio.%(ext)s")}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
    except Exception as e:
        raise VideoError(f"Couldn't download the audio: {e}") from e
    files = list(Path(tmpdir).glob("audio.*"))
    if not files:
        raise VideoError("Audio download produced no file.")
    return str(files[0])


def _compress(path: str, tmpdir: str) -> str:
    """Mono 16 kHz 32 kbps mp3: ~14 MB per hour, under OpenAI's 25 MB limit."""
    out = os.path.join(tmpdir, "speech.mp3")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-vn", "-ac", "1",
                    "-ar", "16000", "-b:a", "32k", out], check=True)
    return out


def transcribe(path: str) -> list[dict]:
    with tempfile.TemporaryDirectory() as tmpdir:
        audio = _compress(path, tmpdir)
        if os.environ.get("OPENAI_API_KEY"):
            if os.path.getsize(audio) > OPENAI_LIMIT_BYTES:
                raise VideoError("Audio is too long for the OpenAI transcription limit.")
            from openai import OpenAI
            with open(audio, "rb") as f:
                resp = OpenAI().audio.transcriptions.create(
                    model="whisper-1", file=f, response_format="verbose_json")
            return [{"start": s.start, "text": s.text} for s in (resp.segments or [])]
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise VideoError("No captions found, and no speech-to-text is set up. Set "
                             "OPENAI_API_KEY or `pip install faster-whisper`.") from e
        model = WhisperModel(WHISPER_LOCAL_MODEL, device="cpu", compute_type="int8")
        segments, _ = model.transcribe(audio, vad_filter=True)
        return [{"start": s.start, "text": s.text} for s in segments]


def get_video_transcript(url: str) -> dict:
    segments, info = fetch_captions(url)
    if segments:
        return {"segments": segments, "method": "captions", "title": info.get("title", "")}
    with tempfile.TemporaryDirectory() as tmpdir:
        audio = download_audio(url, info, tmpdir)
        segments = transcribe(audio)
    if not segments:
        raise VideoError("No speech was detected in this video.")
    return {"segments": segments, "method": "speech-to-text", "title": info.get("title", "")}
