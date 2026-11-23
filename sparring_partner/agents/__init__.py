"""Agents. Each takes an ``LLMClient`` (or ``None`` for offline mode)."""

from .chat import case_chat, doc_chat
from .gaps import find_gaps
from .recheck import recheck
from .structure import structure
from .support import find_supported

__all__ = ["case_chat", "doc_chat", "find_gaps", "find_supported", "recheck", "structure"]
