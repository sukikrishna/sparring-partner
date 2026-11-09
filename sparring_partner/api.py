"""HTTP API and static file server.

    uvicorn sparring_partner.api:app --reload
    # or: sparring-partner serve

The API enforces the information barrier between roles: every endpoint takes
a role and only ever reads documents that role may see. Raw per-case corpus
files are therefore not served when the API is running.
"""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, agents, config
from .corpus import CaseNotFound, list_cases, load_case, role_view
from .llm import LLMError, get_client
from .schemas import (
    CaseAnswer,
    CaseChatRequest,
    DocAnswer,
    DocChatRequest,
    Gap,
    GapsRequest,
    RecheckRequest,
    RecheckResult,
    StructuredView,
    StructureRequest,
)

log = logging.getLogger("sparring_partner")

app = FastAPI(title="Sparring Partner", version=__version__)


@app.exception_handler(CaseNotFound)
async def _case_not_found(_: Request, err: CaseNotFound) -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": f"Unknown case: {err.args[0]}"})


@app.exception_handler(LLMError)
async def _llm_error(_: Request, err: LLMError) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": str(err)})


def _case_and_role(case_id: str, role_id: str):
    case = load_case(case_id)
    try:
        return case, case.role(role_id)
    except KeyError as err:
        raise HTTPException(404, f"Unknown role: {role_id}") from err


# ---------------------------------------------------------------------- meta


@app.get("/api/health")
def health() -> dict:
    client = get_client()
    return {
        "status": "ok",
        "version": __version__,
        "llm": client is not None,
        "model": config.DEFAULT_MODEL if client is not None else None,
        "session_logs": config.ACCEPT_SESSION_LOGS,
    }


@app.get("/api/cases")
def cases() -> dict:
    return {"cases": list_cases()}


@app.get("/api/cases/{case_id}")
def case_for_role(case_id: str, role: str) -> dict:
    case, _ = _case_and_role(case_id, role)
    return role_view(case, role)


# -------------------------------------------------------------------- agents


@app.post("/api/gaps", response_model=list[Gap])
def gaps(req: GapsRequest) -> list[Gap]:
    case, role = _case_and_role(req.case_id, req.role_id)
    return agents.find_gaps(get_client(), case, role, req.notes, req.max_gaps)


@app.post("/api/chat/document", response_model=DocAnswer)
def chat_document(req: DocChatRequest) -> DocAnswer:
    case, role = _case_and_role(req.case_id, req.role_id)
    try:
        doc = case.document(req.doc_id, role.id)
    except KeyError as err:
        raise HTTPException(404, f"Document {req.doc_id} is not available to this role") from err
    return agents.doc_chat(get_client(), case, role, doc, req.question, req.notes, req.gap, req.history)


@app.post("/api/chat/case", response_model=CaseAnswer)
def chat_case(req: CaseChatRequest) -> CaseAnswer:
    case, role = _case_and_role(req.case_id, req.role_id)
    return agents.case_chat(get_client(), case, role, req.question, req.notes, req.history)


@app.post("/api/structure", response_model=StructuredView)
def structure(req: StructureRequest) -> StructuredView:
    case, role = _case_and_role(req.case_id, req.role_id)
    return agents.structure(get_client(), case, role, req.notes, req.insights)


@app.post("/api/recheck", response_model=RecheckResult)
def recheck(req: RecheckRequest) -> RecheckResult:
    case, role = _case_and_role(req.case_id, req.role_id)
    return agents.recheck(get_client(), case, role, req.gap, req.revised_passage, req.notes)


# ------------------------------------------------------------- session logs


@app.post("/api/sessions")
async def save_session(request: Request) -> dict:
    """Store an exported session (notes, insights, event log). Opt-in for studies."""
    if not config.ACCEPT_SESSION_LOGS:
        raise HTTPException(403, "Session logging is disabled (set SPARRING_ACCEPT_SESSION_LOGS=1).")
    body = await request.body()
    if len(body) > 5_000_000:
        raise HTTPException(413, "Session too large")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as err:
        raise HTTPException(400, "Body must be JSON") from err
    session_id = re.sub(r"[^A-Za-z0-9_-]", "", str(payload.get("session_id", "")))[:64] or "anon"
    config.SESSION_LOG_DIR.mkdir(parents=True, exist_ok=True)
    path = config.SESSION_LOG_DIR / f"{int(time.time())}-{session_id}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1))
    return {"saved": path.name}


# -------------------------------------------------------------------- static


@app.get("/data/cases/{name}")
def corpus_file(name: str):
    """Only the case index is public; per-case files would bypass the role barrier."""
    if name != "index.json":
        raise HTTPException(404, "Use /api/cases/{case_id}?role=... instead")
    return FileResponse(config.CORPUS_DIR / "index.json")


if Path(config.WEB_DIR).is_dir():
    app.mount("/", StaticFiles(directory=config.WEB_DIR, html=True), name="web")
