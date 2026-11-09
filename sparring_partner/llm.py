"""LLM access. Agents depend on the small ``LLMClient`` protocol only.

``ClaudeClient`` calls the Anthropic Messages API with structured outputs.
``StubLLMClient`` serves canned objects for tests. ``get_client()`` returns
``None`` when no model is configured, and every agent then falls back to a
retrieval-only answer.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Callable, Protocol, TypeVar

from pydantic import BaseModel

from . import config

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class LLMError(RuntimeError):
    """Raised when a model call fails in a way the user should see."""


class LLMClient(Protocol):
    def parse(
        self,
        *,
        task: str,
        system: str,
        messages: list[dict],
        output_format: type[T],
    ) -> T: ...


def cached_block(text: str) -> dict:
    """A text content block marked for prompt caching (for long, stable context)."""
    return {"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}


class ClaudeClient:
    """Structured calls through ``client.beta.messages.parse``.

    - Adaptive thinking; effort is set per task in ``config.TASKS``.
    - The system prompt is sent as a cached block; agents mark long document
      context with ``cached_block`` so repeated chat turns reuse the cache.
    - Server-side refusal fallback is on by default (``SPARRING_FALLBACKS``);
      if the API rejects it, it is dropped for the rest of the process.
    """

    FALLBACK_BETA = "server-side-fallback-2026-07-01"

    def __init__(self) -> None:
        import anthropic  # imported lazily: optional dependency

        self._anthropic = anthropic
        self._client = anthropic.Anthropic()
        self._fallbacks = config.FALLBACKS == "default"

    def _kwargs(self, task: str, system: str, messages: list[dict]) -> dict[str, Any]:
        spec = config.TASKS.get(task, {"model": config.DEFAULT_MODEL, "effort": "medium"})
        kwargs: dict[str, Any] = {
            "model": spec["model"],
            "max_tokens": config.MAX_TOKENS,
            "system": [cached_block(system)],
            "messages": messages,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": spec["effort"]},
        }
        if self._fallbacks:
            kwargs["betas"] = [self.FALLBACK_BETA]
            kwargs["fallbacks"] = "default"
        return kwargs

    def parse(self, *, task: str, system: str, messages: list[dict], output_format: type[T]) -> T:
        anthropic = self._anthropic
        kwargs = self._kwargs(task, system, messages)
        try:
            try:
                response = self._client.beta.messages.parse(output_format=output_format, **kwargs)
            except anthropic.BadRequestError as err:
                if self._fallbacks and "fallback" in str(err).lower():
                    log.warning("refusal fallbacks rejected by the API; continuing without them")
                    self._fallbacks = False
                    kwargs.pop("betas", None)
                    kwargs.pop("fallbacks", None)
                    response = self._client.beta.messages.parse(output_format=output_format, **kwargs)
                else:
                    raise
        except anthropic.AuthenticationError as err:
            raise LLMError("Claude API credentials were rejected.") from err
        except anthropic.NotFoundError as err:
            raise LLMError(f"Model not found: {kwargs['model']}") from err
        except anthropic.RateLimitError as err:
            raise LLMError("Rate limited by the Claude API; try again shortly.") from err
        except anthropic.APIStatusError as err:
            raise LLMError(f"Claude API error ({err.status_code}).") from err
        except anthropic.APIConnectionError as err:
            raise LLMError("Could not reach the Claude API.") from err

        if response.stop_reason == "refusal":
            raise LLMError("The model declined this request.")
        if response.stop_reason == "max_tokens":
            raise LLMError("The model ran out of output tokens; try a shorter input.")
        parsed = response.parsed_output
        if parsed is None:
            raise LLMError("The model returned no structured output.")
        return parsed


class StubLLMClient:
    """Deterministic client for tests. Register a factory per output type."""

    def __init__(self, factories: dict[type, Callable[[dict], BaseModel]] | None = None) -> None:
        self.factories = factories or {}
        self.calls: list[dict] = []

    def parse(self, *, task: str, system: str, messages: list[dict], output_format: type[T]) -> T:
        call = {"task": task, "system": system, "messages": messages}
        self.calls.append(call)
        factory = self.factories.get(output_format)
        if factory is None:
            raise LLMError(f"StubLLMClient has no factory for {output_format.__name__}")
        return factory(call)  # type: ignore[return-value]


def _has_credentials() -> bool:
    if any(os.environ.get(k) for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")):
        return True
    # Profiles from `ant auth login` live here; the SDK picks them up itself.
    return os.path.isdir(os.path.expanduser("~/.config/anthropic"))


_client: LLMClient | None = None
_resolved = False


def get_client() -> LLMClient | None:
    """The process-wide client, or None in offline mode."""
    global _client, _resolved
    if _resolved:
        return _client
    _resolved = True
    mode = config.LLM_MODE
    if mode == "offline":
        _client = None
    elif mode == "anthropic" or (mode == "auto" and _has_credentials()):
        try:
            _client = ClaudeClient()
        except ImportError:
            log.warning("anthropic package not installed; running offline (pip install 'sparring-partner[llm]')")
            _client = None
    else:
        _client = None
    return _client


def set_client(client: LLMClient | None) -> None:
    """Override the process-wide client (tests, notebooks)."""
    global _client, _resolved
    _client, _resolved = client, True
