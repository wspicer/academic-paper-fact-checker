const DEFAULTS = { backendUrl: "http://localhost:8000", apiToken: "", maxClaims: 5 };
const fields = Object.keys(DEFAULTS);

chrome.storage.sync.get(fields).then((stored) => {
  const s = { ...DEFAULTS, ...stored };
  fields.forEach((f) => (document.getElementById(f).value = s[f]));
});

document.getElementById("save").onclick = async () => {
  const values = Object.fromEntries(fields.map((f) => [f, document.getElementById(f).value.trim()]));
  values.maxClaims = Math.max(1, Math.min(10, parseInt(values.maxClaims, 10) || 5));
  await chrome.storage.sync.set(values);
  document.getElementById("saved").textContent = "Saved ✓";
  setTimeout(() => (document.getElementById("saved").textContent = ""), 1500);
};
