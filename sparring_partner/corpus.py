"""Loading built case corpora (``web/data/cases/<id>.json``)."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from . import config
from .schemas import Case


class CaseNotFound(KeyError):
    pass


def _path(case_id: str, corpus_dir: Path) -> Path:
    if not case_id.replace("-", "").replace("_", "").isalnum():
        raise CaseNotFound(case_id)
    return corpus_dir / f"{case_id}.json"


@lru_cache(maxsize=32)
def load_case(case_id: str, corpus_dir: Path | None = None) -> Case:
    path = _path(case_id, corpus_dir or config.CORPUS_DIR)
    if not path.exists():
        raise CaseNotFound(case_id)
    return Case.model_validate_json(path.read_text())


def list_cases(corpus_dir: Path | None = None) -> list[dict]:
    index = (corpus_dir or config.CORPUS_DIR) / "index.json"
    if not index.exists():
        return []
    return json.loads(index.read_text())["cases"]


def role_view(case: Case, role_id: str) -> dict:
    """What a participant in ``role_id`` is allowed to receive."""
    role = case.role(role_id)
    return {
        "id": case.id,
        "title": case.title,
        "summary": case.summary,
        "role": role.model_dump(),
        "roles": [{"id": r.id, "name": r.name} for r in case.roles],
        "documents": [d.model_dump(exclude={"source"}) for d in case.visible_documents(role_id)],
    }
