"""
Core fact-checking pipeline (no UI):
  claim -> search queries -> OpenAlex + Semantic Scholar -> dedupe/rerank -> Claude verdict
"""
import json
import os
import re
import threading
import time

import requests

MODEL = "claude-sonnet-5-5"
OPENALEX_URL = "https://api.openalex.org/works"
S2_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
UA = {"User-Agent": "science-fact-checker/1.0"}

# Semantic Scholar keys allow ~1 request/second; serialize calls across threads.
_s2_lock = threading.Lock()
_s2_last = [0.0]


def _s2_throttle(min_interval: float = 1.1):
    with _s2_lock:
        wait = _s2_last[0] + min_interval - time.time()
        if wait > 0:
            time.sleep(wait)
        _s2_last[0] = time.time()


def get_secret(name: str) -> str | None:
    """Read from Streamlit secrets if available, else environment."""
    try:
        import streamlit as st
        if name in st.secrets:
            return st.secrets[name]
    except Exception:
        pass
    return os.environ.get(name)


# ---------- Claude helper ----------
def call_claude(system: str, prompt: str, api_key: str, max_tokens: int = 1500) -> str:
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    msg = client.messages.create(
        model=MODEL, max_tokens=max_tokens, system=system,
        messages=[{"role": "user", "content": prompt}],
    )
    return msg.content[0].text


def parse_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError(f"No JSON in model output: {text[:200]}")
    return json.loads(match.group(0))


# ---------- 1. Turn the claim into search queries ----------
def make_queries(claim: str, api_key: str) -> list[str]:
    system = ("Turn the user's claim into 2 short academic search queries (3-8 words each) "
              "that would find papers supporting OR refuting it. Use scientific terms. "
              'Reply only with JSON: {"queries": ["...", "..."]}')
    try:
        return parse_json(call_claude(system, claim, api_key, 200))["queries"][:3]
    except Exception:
        return [claim]


# ---------- 2. Search ----------
def _abstract_from_inverted(inv: dict | None) -> str:
    if not inv:
        return ""
    words = {}
    for word, positions in inv.items():
        for p in positions:
            words[p] = word
    return " ".join(words[i] for i in sorted(words))


def search_openalex(query: str, n: int = 10) -> list[dict]:
    params = {"search": query, "per_page": n,
              "filter": "has_abstract:true",
              "select": "id,doi,title,publication_year,abstract_inverted_index,"
                        "cited_by_count,is_retracted,primary_location,type"}
    key = get_secret("OPENALEX_API_KEY")
    if key:
        params["api_key"] = key
    r = requests.get(OPENALEX_URL, params=params, headers=UA, timeout=20)
    r.raise_for_status()
    out = []
    for w in r.json().get("results", []):
        src = ((w.get("primary_location") or {}).get("source") or {}).get("display_name")
        out.append({
            "title": w.get("title") or "",
            "year": w.get("publication_year"),
            "doi": (w.get("doi") or "").replace("https://doi.org/", "").lower() or None,
            "url": w.get("doi") or w.get("id"),
            "abstract": _abstract_from_inverted(w.get("abstract_inverted_index")),
            "citations": w.get("cited_by_count", 0),
            "retracted": bool(w.get("is_retracted")),
            "venue": src,
            "source": "OpenAlex",
        })
    return out


def search_semantic_scholar(query: str, n: int = 10) -> list[dict]:
    headers = dict(UA)
    key = get_secret("S2_API_KEY")
    if key:
        headers["x-api-key"] = key
    params = {"query": query, "limit": n,
              "fields": "title,abstract,year,externalIds,citationCount,tldr,venue,url"}
    for attempt in range(3):                      # back off on 429
        _s2_throttle()
        r = requests.get(S2_URL, params=params, headers=headers, timeout=20)
        if r.status_code != 429:
            break
        time.sleep(1.5 * (attempt + 1))
    r.raise_for_status()
    out = []
    for p in r.json().get("data", []) or []:
        abstract = p.get("abstract") or ((p.get("tldr") or {}).get("text") or "")
        if not abstract:
            continue
        doi = (p.get("externalIds") or {}).get("DOI")
        out.append({
            "title": p.get("title") or "",
            "year": p.get("year"),
            "doi": doi.lower() if doi else None,
            "url": f"https://doi.org/{doi}" if doi else p.get("url"),
            "abstract": abstract,
            "citations": p.get("citationCount", 0),
            "retracted": False,
            "venue": p.get("venue"),
            "source": "Semantic Scholar",
        })
    return out


def gather_papers(queries: list[str]) -> tuple[list[dict], list[str]]:
    papers, errors = [], []
    for q in queries:
        for fn in (search_openalex, search_semantic_scholar):
            try:
                papers += fn(q)
            except Exception as e:
                errors.append(f"{fn.__name__}('{q}'): {e}")
    return dedupe(papers), errors


def dedupe(papers: list[dict]) -> list[dict]:
    seen, out = {}, []
    for p in papers:
        key = p["doi"] or re.sub(r"\W+", "", p["title"].lower())[:80]
        if not key:
            continue
        if key in seen:
            prev = seen[key]                      # keep the richer record, OR the retraction flag
            prev["retracted"] = prev["retracted"] or p["retracted"]
            if len(p["abstract"]) > len(prev["abstract"]):
                prev["abstract"] = p["abstract"]
            continue
        seen[key] = p
        out.append(p)
    return out


# ---------- 3. Rerank ----------
def rerank(claim: str, papers: list[dict], k: int = 8) -> list[dict]:
    """TF-IDF similarity to the claim, with a small boost for well-cited papers."""
    if not papers:
        return []
    from math import log
    from sklearn.feature_extraction.text import TfidfVectorizer
    docs = [f"{p['title']} {p['abstract']}" for p in papers]
    vec = TfidfVectorizer(stop_words="english", ngram_range=(1, 2)).fit(docs + [claim])
    sims = (vec.transform(docs) @ vec.transform([claim]).T).toarray().ravel()
    for p, s in zip(papers, sims):
        p["relevance"] = float(s) * (1 + 0.05 * log(1 + (p["citations"] or 0)))
    usable = [p for p in papers if not p["retracted"]]
    return sorted(usable, key=lambda p: -p["relevance"])[:k]


# ---------- 4. Verdict ----------
VERDICT_SYSTEM = """You are a careful scientific fact checker. Judge the claim using ONLY the
paper abstracts provided. Do not use outside knowledge to fill gaps.

Rules:
- "supported": multiple relevant papers clearly back the claim.
- "contradicted": relevant papers clearly go against it.
- "mixed": relevant papers disagree.
- "insufficient evidence": papers are off-topic, too few, or too weak.
- Note when evidence is only in animals/cells, small samples, or correlational.
- Overstated claims ("cures", "always", "proves") are usually only partly supported.

Reply ONLY with JSON:
{"verdict": "supported|contradicted|mixed|insufficient evidence",
 "confidence": "low|medium|high",
 "summary": "2-3 plain-English sentences",
 "caveats": ["..."],
 "papers": [{"n": 1, "stance": "supports|contradicts|neutral|irrelevant", "note": "one line"}]}"""


def judge(claim: str, papers: list[dict], api_key: str) -> dict:
    if not papers:
        return {"verdict": "insufficient evidence", "confidence": "low",
                "summary": "No relevant papers with abstracts were found.",
                "caveats": [], "papers": []}
    evidence = "\n\n".join(
        f"[{i}] {p['title']} ({p['year']}, {p['venue'] or 'unknown venue'}, "
        f"{p['citations']} citations)\n{p['abstract'][:1500]}"
        for i, p in enumerate(papers, 1))
    return parse_json(call_claude(VERDICT_SYSTEM,
                                  f"Claim: {claim}\n\nPapers:\n{evidence}", api_key))


def check_claim(claim: str, api_key: str) -> dict:
    queries = make_queries(claim, api_key)
    papers, errors = gather_papers(queries)
    retracted = [p for p in papers if p["retracted"]]
    top = rerank(claim, papers)
    result = judge(claim, top, api_key)
    return {"claim": claim, "queries": queries, "papers": top,
            "retracted": retracted, "errors": errors, "result": result}
