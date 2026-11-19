// Paper search against OpenAlex and Semantic Scholar, straight from the browser.

const OPENALEX = "https://api.openalex.org/works";
const S2 = "https://api.semanticscholar.org/graph/v1/paper/search";

export function abstractFromInverted(inv) {
  if (!inv) return "";
  const words = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) words[p] = word;
  return words.filter((w) => w !== undefined).join(" ");
}

export async function searchOpenAlex(query, { key, n = 10 } = {}) {
  const params = new URLSearchParams({
    search: query,
    per_page: String(n),
    filter: "has_abstract:true",
    select: "id,doi,title,publication_year,abstract_inverted_index,cited_by_count,is_retracted,primary_location",
  });
  if (key) params.set("api_key", key);
  const res = await fetch(`${OPENALEX}?${params}`);
  if (res.status === 429 || res.status === 402)
    throw new Error("OpenAlex daily limit reached. Add a free OpenAlex key in settings.");
  if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((w) => ({
    title: w.title || "",
    year: w.publication_year,
    doi: (w.doi || "").replace("https://doi.org/", "").toLowerCase() || null,
    url: w.doi || w.id,
    abstract: abstractFromInverted(w.abstract_inverted_index),
    citations: w.cited_by_count || 0,
    retracted: !!w.is_retracted,
    venue: w.primary_location?.source?.display_name || null,
    source: "OpenAlex",
  }));
}

// Semantic Scholar allows ~1 request/second; serialize calls.
let s2Chain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const _s2 = { interval: 1100 }; // exposed for tests

function s2Throttle() {
  const turn = s2Chain.then(() => sleep(_s2.interval));
  s2Chain = turn.catch(() => {});
  return s2Chain;
}

export async function searchSemanticScholar(query, { key, n = 10 } = {}) {
  const params = new URLSearchParams({
    query,
    limit: String(n),
    fields: "title,abstract,year,externalIds,citationCount,tldr,venue,url",
  });
  const headers = key ? { "x-api-key": key } : {};
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    await s2Throttle();
    res = await fetch(`${S2}?${params}`, { headers });
    if (res.status !== 429) break;
    await sleep(1500 * (attempt + 1));
  }
  if (!res.ok) throw new Error(`Semantic Scholar HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || [])
    .map((p) => {
      const doi = p.externalIds?.DOI;
      return {
        title: p.title || "",
        year: p.year,
        doi: doi ? doi.toLowerCase() : null,
        url: doi ? `https://doi.org/${doi}` : p.url,
        abstract: p.abstract || p.tldr?.text || "",
        citations: p.citationCount || 0,
        retracted: false,
        venue: p.venue || null,
        source: "Semantic Scholar",
      };
    })
    .filter((p) => p.abstract);
}

export function dedupe(papers) {
  const seen = new Map();
  for (const p of papers) {
    const key = p.doi || p.title.toLowerCase().replace(/\W+/g, "").slice(0, 80);
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, { ...p });
      continue;
    }
    prev.retracted = prev.retracted || p.retracted; // a retraction flag from either source wins
    if (p.abstract.length > prev.abstract.length) prev.abstract = p.abstract;
  }
  return [...seen.values()];
}

export async function gatherPapers(queries, { openalexKey, s2Key } = {}) {
  const errors = [];
  const jobs = [];
  for (const q of queries) {
    jobs.push(searchOpenAlex(q, { key: openalexKey }).catch((e) => (errors.push(`OpenAlex: ${e.message}`), [])));
    jobs.push(searchSemanticScholar(q, { key: s2Key }).catch((e) => (errors.push(`Semantic Scholar: ${e.message}`), [])));
  }
  const results = (await Promise.all(jobs)).flat();
  return { papers: dedupe(results), errors: [...new Set(errors)] };
}
