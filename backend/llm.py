"""One interface for the language model, whichever provider the user's key is for."""
import os
from dataclasses import dataclass, field

PROVIDERS = ("anthropic", "openai")
DEFAULT_MODELS = {
    "anthropic": os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
    "openai": os.environ.get("OPENAI_MODEL", "gpt-5.6-sol"),
}


class LLMError(Exception):
    """A provider error worth showing to the user (bad key, no credit, unknown model)."""


class LLMAuthError(LLMError):
    pass


@dataclass(frozen=True)
class LLM:
    provider: str
    key: str = field(repr=False)          # never printed in logs or tracebacks
    model: str = ""

    def __post_init__(self):
        if self.provider not in PROVIDERS:
            raise LLMError(f"Unknown provider '{self.provider}'. Use anthropic or openai.")
        if not self.model:
            object.__setattr__(self, "model", DEFAULT_MODELS[self.provider])

    @property
    def label(self) -> str:
        return f"{self.provider}:{self.model}"


def as_llm(llm_or_key) -> LLM:
    """Back-compat: a bare string is treated as an Anthropic key."""
    return llm_or_key if isinstance(llm_or_key, LLM) else LLM("anthropic", llm_or_key)


def call_llm(llm: LLM, system: str, prompt: str, max_tokens: int = 1500) -> str:
    if llm.provider == "anthropic":
        return _anthropic(llm, system, prompt, max_tokens)
    return _openai(llm, system, prompt, max_tokens)


def _anthropic(llm: LLM, system: str, prompt: str, max_tokens: int) -> str:
    import anthropic
    client = anthropic.Anthropic(api_key=llm.key)
    try:
        msg = client.messages.create(model=llm.model, max_tokens=max_tokens, system=system,
                                     messages=[{"role": "user", "content": prompt}])
    except anthropic.AuthenticationError as e:
        raise LLMAuthError("Your Anthropic API key was rejected. Check it in settings.") from e
    except anthropic.PermissionDeniedError as e:
        raise LLMAuthError("Your Anthropic key doesn't have access to this model.") from e
    except anthropic.NotFoundError as e:
        raise LLMError(f"Anthropic model '{llm.model}' wasn't found. Check the model in settings.") from e
    except anthropic.BadRequestError as e:
        if "credit" in str(e).lower():
            raise LLMError("Your Anthropic account is out of credit.") from e
        raise
    return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")


def _openai(llm: LLM, system: str, prompt: str, max_tokens: int) -> str:
    import openai
    client = openai.OpenAI(api_key=llm.key)
    try:
        resp = client.chat.completions.create(
            model=llm.model,
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": prompt}],
            response_format={"type": "json_object"},       # every prompt here asks for JSON
            # reasoning models spend part of this budget thinking, so leave headroom
            max_completion_tokens=max(max_tokens * 4, 4000),
        )
    except openai.AuthenticationError as e:
        raise LLMAuthError("Your OpenAI API key was rejected. Check it in settings.") from e
    except openai.PermissionDeniedError as e:
        raise LLMAuthError("Your OpenAI key doesn't have access to this model.") from e
    except openai.NotFoundError as e:
        raise LLMError(f"OpenAI model '{llm.model}' wasn't found. Check the model in settings.") from e
    except openai.RateLimitError as e:
        if "quota" in str(e).lower():
            raise LLMError("Your OpenAI account is out of credit (quota exceeded).") from e
        raise
    return resp.choices[0].message.content or ""
