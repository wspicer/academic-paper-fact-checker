// BM25 relevance of each paper to the claim, with a small boost for well-cited papers.

const STOP = new Set(
  ("the and for are but not you all any can had her was one our out has have this that with from they will " +
    "would there their what about which when your said each she how its also than them then into more only " +
    "other some such these those very just over most may might been being were does did study studies results " +
    "using used use based between among however").split(" ")
);

export function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 2 && !STOP.has(t));
}

export function bm25Scores(query, docs, k1 = 1.5, b = 0.75) {
  const qTerms = [...new Set(tokenize(query))];
  const docTokens = docs.map(tokenize);
  const N = docs.length;
  const avgLen = docTokens.reduce((s, d) => s + d.length, 0) / Math.max(N, 1) || 1;
  const df = new Map();
  for (const toks of docTokens) for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  return docTokens.map((toks) => {
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of qTerms) {
      const f = tf.get(q);
      if (!f) continue;
      const n = df.get(q) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks.length) / avgLen));
    }
    return score;
  });
}

export function rerank(claim, papers, k = 8) {
  const usable = papers.filter((p) => !p.retracted);
  const scores = bm25Scores(claim, usable.map((p) => `${p.title} ${p.title} ${p.abstract}`));
  return usable
    .map((p, i) => ({ ...p, relevance: scores[i] * (1 + 0.05 * Math.log(1 + (p.citations || 0))) }))
    .filter((p) => p.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, k);
}
