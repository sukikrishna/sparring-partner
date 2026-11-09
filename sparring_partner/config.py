"""Runtime configuration, read from environment variables (and an optional .env)."""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    """Load KEY=VALUE lines from <repo>/.env. Exported variables always win."""
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip("'\"")
        if key and value and key not in os.environ:
            os.environ[key] = value


_load_dotenv()


def _path(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    return Path(value).expanduser().resolve() if value else default


# --- Paths --------------------------------------------------------------------

#: Case manifests (checked in): one folder per case with a manifest.toml.
MANIFEST_DIR = _path("SPARRING_MANIFEST_DIR", REPO_ROOT / "cases")
#: Raw case material (docx/pdf), never committed.
RAW_DIR = _path("SPARRING_RAW_DIR", REPO_ROOT / "cases_raw")
#: Built corpus JSON, served to the browser as static files.
CORPUS_DIR = _path("SPARRING_CORPUS_DIR", REPO_ROOT / "web" / "data" / "cases")
#: Frontend root.
WEB_DIR = _path("SPARRING_WEB_DIR", REPO_ROOT / "web")
#: Where session logs posted by the browser are stored (opt-in, see API).
SESSION_LOG_DIR = _path("SPARRING_SESSION_LOG_DIR", REPO_ROOT / "sessions")

# --- LLM ----------------------------------------------------------------------

#: "auto" uses Claude when credentials are present, "anthropic" requires them,
#: "offline" never calls a model (retrieval-only answers).
LLM_MODE = os.environ.get("SPARRING_LLM_MODE", "auto").lower()

DEFAULT_MODEL = os.environ.get("SPARRING_MODEL", "claude-opus-5-5")

#: Per-task model and effort. Chat turns are latency-sensitive; gap finding
#: and structuring read the whole case and benefit from more reasoning.
TASKS: dict[str, dict[str, str]] = {
    "gaps": {"model": DEFAULT_MODEL, "effort": os.environ.get("SPARRING_EFFORT_GAPS", "high")},
    "doc_chat": {"model": DEFAULT_MODEL, "effort": os.environ.get("SPARRING_EFFORT_CHAT", "low")},
    "case_chat": {"model": DEFAULT_MODEL, "effort": os.environ.get("SPARRING_EFFORT_CHAT", "low")},
    "structure": {"model": DEFAULT_MODEL, "effort": os.environ.get("SPARRING_EFFORT_STRUCTURE", "medium")},
    "recheck": {"model": DEFAULT_MODEL, "effort": "low"},
}

MAX_TOKENS = int(os.environ.get("SPARRING_MAX_TOKENS", "16000"))

#: Server-side refusal fallback ("default" or "off").
FALLBACKS = os.environ.get("SPARRING_FALLBACKS", "default").lower()

# --- Retrieval ----------------------------------------------------------------

CASE_CHAT_K = int(os.environ.get("SPARRING_CASE_CHAT_K", "12"))

# --- Server -------------------------------------------------------------------

#: Accept session logs posted by the browser (for user studies). Off by default.
ACCEPT_SESSION_LOGS = os.environ.get("SPARRING_ACCEPT_SESSION_LOGS", "0") == "1"
