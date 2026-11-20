// Caches verdicts on this device (never API keys), so re-checking a claim is free.
const TTL_MS = 7 * 24 * 3600 * 1000;
const PREFIX = "cache:";
const memory = new Map(); // used outside the extension (tests)
const store = () => globalThis.chrome?.storage?.local;

async function hash(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function cacheKey(claim, llm, mode = "full") {
  return PREFIX + (await hash(`${llm.provider}|${llm.model}|${mode}|${claim.trim().toLowerCase()}`));
}

export async function cacheGet(key) {
  const s = store();
  const entry = s ? (await s.get(key))[key] : memory.get(key);
  if (!entry || Date.now() - entry.t > TTL_MS) return null;
  return entry.data;
}

export async function cacheSet(key, data) {
  const entry = { t: Date.now(), data };
  const s = store();
  if (s) await s.set({ [key]: entry });
  else memory.set(key, entry);
}

export async function cachePrune() {
  const s = store();
  if (!s) return;
  const all = await s.get(null);
  const old = Object.keys(all).filter((k) => k.startsWith(PREFIX) && Date.now() - all[k].t > TTL_MS);
  if (old.length) await s.remove(old);
}

export async function cacheClear() {
  const s = store();
  if (!s) return memory.clear();
  const all = await s.get(null);
  await s.remove(Object.keys(all).filter((k) => k.startsWith(PREFIX)));
}
