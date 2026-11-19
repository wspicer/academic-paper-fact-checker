"""Pull check-worthy research claims out of page text or a video transcript."""
from checker import call_claude, parse_json

MAX_PAGE_CHARS = 60_000
MAX_TRANSCRIPT_CHARS = 150_000

EXTRACT_SYSTEM = """You find factual claims in content that can be checked against published
scientific research (health, medicine, nutrition, psychology, climate, physics, biology,
social science, etc.).

Pick the {n} most check-worthy claims: specific, consequential, and testable by studies.
Skip opinions, predictions, personal anecdotes, quotes about events, and trivia.
Prefer claims a reader might act on or share. Never invent claims that aren't there.

For each claim give:
- "claim": a short, standalone version (resolve "it"/"this" so it makes sense alone)
- "quote": the EXACT words from the content where it's made, copied verbatim, 5-30 words
- "timestamp": {timestamp_rule}

Reply ONLY with JSON: {{"claims": [{{"claim": "...", "quote": "...", "timestamp": null}}]}}
If there are no research-checkable claims, return {{"claims": []}}."""


def fmt_time(seconds: float) -> str:
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def format_transcript(segments: list[dict], window: float = 20.0) -> str:
    """Merge caption segments into ~20 s lines prefixed with [m:ss]."""
    lines, buf, start = [], [], None
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        if start is None:
            start = float(seg.get("start", 0))
        buf.append(text)
        if float(seg.get("start", 0)) - start >= window:
            lines.append(f"[{fmt_time(start)}] {' '.join(buf)}")
            buf, start = [], None
    if buf:
        lines.append(f"[{fmt_time(start or 0)}] {' '.join(buf)}")
    return "\n".join(lines)


def _parse_ts(value) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        parts = [float(p) for p in str(value).strip("[] ").split(":")]
    except ValueError:
        return None
    total = 0.0
    for p in parts:
        total = total * 60 + p
    return total


def extract_claims(text: str, api_key: str, n: int = 5, transcript: bool = False,
                   title: str = "") -> list[dict]:
    limit = MAX_TRANSCRIPT_CHARS if transcript else MAX_PAGE_CHARS
    rule = ("the [m:ss] marker of the line where the claim is made, as a string like \"4:05\""
            if transcript else "null")
    system = EXTRACT_SYSTEM.format(n=n, timestamp_rule=rule)
    kind = "Video transcript" if transcript else "Web page"
    prompt = f"{kind} title: {title or 'unknown'}\n\n{text[:limit]}"
    data = parse_json(call_claude(system, prompt, api_key, max_tokens=2000))
    out = []
    for c in data.get("claims", [])[:n]:
        if not c.get("claim"):
            continue
        out.append({"claim": c["claim"].strip(),
                    "quote": (c.get("quote") or "").strip(),
                    "timestamp": _parse_ts(c.get("timestamp")) if transcript else None})
    return out
