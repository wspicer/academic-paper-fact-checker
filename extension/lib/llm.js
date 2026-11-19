// Calls Anthropic or OpenAI directly from the user's browser.
// The key is sent ONLY to the provider's own API host, never anywhere else.

export const PROVIDERS = {
  anthropic: { label: "Anthropic", defaultModel: "claude-sonnet-5-5", host: "https://api.anthropic.com" },
  openai: { label: "OpenAI", defaultModel: "gpt-5.6-sol", host: "https://api.openai.com" },
};

export class LLMError extends Error {
  constructor(message, { auth = false } = {}) {
    super(message);
    this.name = "LLMError";
    this.auth = auth;
  }
}

export function resolveLLM({ provider, key, model }) {
  if (!PROVIDERS[provider]) throw new LLMError(`Unknown AI provider "${provider}".`);
  if (!key) throw new LLMError(`Add your ${PROVIDERS[provider].label} API key in settings.`, { auth: true });
  return { provider, key, model: model || PROVIDERS[provider].defaultModel };
}

async function post(url, headers, body, provider) {
  // Defense in depth: refuse to send a key to any host but the provider's.
  if (!url.startsWith(PROVIDERS[provider].host + "/")) throw new LLMError("Blocked request to unexpected host.");
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    throw new LLMError(`Couldn't reach ${PROVIDERS[provider].label}. Check your internet connection.`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const msg = (data.error && (data.error.message || data.error.type)) || `HTTP ${res.status}`;
  const name = PROVIDERS[provider].label;
  if (res.status === 401) throw new LLMError(`Your ${name} API key was rejected. Check it in settings.`, { auth: true });
  if (res.status === 403) throw new LLMError(`Your ${name} key doesn't have access to this model.`, { auth: true });
  if (res.status === 404) throw new LLMError(`${name} model not found. Check the model name in settings.`);
  if (/credit|quota|billing/i.test(msg)) throw new LLMError(`Your ${name} account is out of credit.`);
  if (res.status === 429) throw new LLMError(`${name} rate limit hit. Wait a minute and try again.`);
  throw new LLMError(`${name} error: ${msg}`);
}

export async function callLLM(llm, system, prompt, maxTokens = 1500) {
  if (llm.provider === "anthropic") {
    const data = await post(
      "https://api.anthropic.com/v1/messages",
      {
        "content-type": "application/json",
        "x-api-key": llm.key,
        "anthropic-version": "2023-06-01",
        // Required by Anthropic for calls made from a browser.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      { model: llm.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] },
      "anthropic"
    );
    return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  const data = await post(
    "https://api.openai.com/v1/chat/completions",
    { "content-type": "application/json", authorization: `Bearer ${llm.key}` },
    {
      model: llm.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" }, // every prompt here asks for JSON
      max_completion_tokens: Math.max(maxTokens * 4, 4000), // reasoning models need headroom
    },
    "openai"
  );
  return data.choices?.[0]?.message?.content || "";
}

export function parseJSON(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error("The AI didn't return valid JSON.");
  return JSON.parse(m[0]);
}
