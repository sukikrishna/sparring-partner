# Architecture

Sparring Partner is a small Python service plus a dependency-free browser app.

```
 cases_raw/  ──ingest──▶  web/data/cases/<case>.json  ──▶  FastAPI (sparring_partner.api)  ──▶  browser (web/)
 (docx, pdf)   manifests    corpus: documents, roles,        role-scoped data + agents           three columns
               in cases/    paragraphs, visibility           Claude via the Anthropic SDK
```

## Components

| Path | Responsibility |
|---|---|
| `cases/<id>/manifest.toml` | Declares a case: roles, briefs, starter notes, and every document with the roles allowed to see it. |
| `sparring_partner/ingest.py` | Extracts paragraphs from `.docx`/`.pdf`/`.txt`, applies manifest options (splitting, fix-ups), validates, writes the corpus JSON and `index.json`. |
| `sparring_partner/corpus.py` | Loads corpora; `role_view()` returns only what a role may see. |
| `sparring_partner/retrieval.py` | In-memory BM25 over paragraphs, cached per (case, role). No external search service. |
| `sparring_partner/llm.py` | `LLMClient` protocol; `ClaudeClient` (structured outputs, adaptive thinking, per-task effort, prompt caching, refusal fallback); `StubLLMClient` for tests. |
| `sparring_partner/agents/` | Gap finder, document chat, case chat, structurer, recheck. Each works offline with a retrieval-only or heuristic fallback. |
| `sparring_partner/api.py` | HTTP API and static file server. |
| `web/` | Vanilla ES modules, no build step. Works against the API or as static files. |

## The information barrier

Cases are role-play simulations: each party holds documents the other must not
see. The barrier is enforced in one place, `Case.visible_documents(role_id)`,
and everything downstream goes through it:

- `GET /api/cases/{id}?role=` returns only visible documents;
- every agent builds its prompt from visible documents only (tests assert that
  text unique to the other role never appears in a prompt, with a positive
  control);
- retrieval indexes are built per role;
- model citations to documents outside the role are dropped;
- raw per-case JSON files are not served while the API is running.

Static hosting (no Python) cannot enforce the barrier because the corpus file is
public; the frontend filters by role for convenience only.

## Where AI insights come from

Every item on the synthesis board records its origin:

| Origin | Produced by | Grounding |
|---|---|---|
| Document chat ("rabbit hole") | `agents.chat.doc_chat` | One document, cited by paragraph. Separate history per gap and document. |
| Case chat ("Ask all documents") | `agents.chat.case_chat` | BM25 passages from all visible documents, cited by document and paragraph. |
| Your note | the negotiator | None needed; labelled as human. |

Chats return an optional `key_finding`, a single self-contained sentence. The
board saves it automatically or on request (a per-session setting), linked to
the gap the chat belonged to or to *General*. Users can re-file any card.

The **structured view** is a different kind of AI output: it does not add
information, it reorganises the negotiator's own notes (and, optionally, saved
insights) into negotiation-framework sections. Each item carries a `basis`
(`notes` with the phrase it restates, `insight` with an id, or `framework` for
open questions). The server checks those references and downgrades any it
cannot verify.

## Agents

All agents share a preamble (`agents/common.py: PRINCIPLES`): ground claims in
the documents, prefer questions to prescriptions, flag partisan or unverified
sources.

| Agent | Input | Output | Post-processing |
|---|---|---|---|
| Gap finder | role brief, all visible documents (cached), notes | `GapSet` | quotes anchored to exact spans of the notes (fuzzy match to a sentence if needed), duplicates and invisible documents dropped, sorted by severity |
| Document chat | role brief + one document (cached), notes, optional gap, history | `DocAnswer` | paragraph numbers clamped to the document |
| Case chat | role brief, notes, top-k passages, history | `CaseAnswer` | citations restricted to visible documents, de-duplicated |
| Structurer | role brief, notes, saved insights | `StructuredView` | provenance verified |
| Recheck | original passage, assumption, revised passage | `RecheckResult` | — |

Model calls go through `client.beta.messages.parse` with a Pydantic schema, so
every response is validated. Configuration lives in `config.TASKS` (model and
effort per task) and environment variables (see the README).

## Frontend

```
web/js/
  main.js       boot, case/role/mode selection, top bar
  store.js      state, localStorage persistence per case/role/mode, event log, export
  api.js        backend detection, data loading, API calls
  engine.js     one interface over demo (scripted + passage search) and live (API) modes
  editor.js     Human-Only editor: highlights, submit/recheck, dismiss/reopen
  sources.js    gaps, library, document and case chats
  synthesis.js  board and structured view
  search.js     client-side BM25 (mirrors retrieval.py)
```

The editor is never re-rendered by other components; highlights are added and
removed in place so the cursor and undo history survive. Highlights can span
several text nodes (each segment becomes its own `<mark>`).

## Modes

| Mode | Needs | Gaps | Chats | Structured view |
|---|---|---|---|---|
| Scripted demo | nothing (static files) | prepared, for the starter notes of scripted roles | prepared answers; otherwise best-matching passages | prepared, for the starter notes |
| Live | Python server + Claude credentials | generated for any notes | generated, cited | generated from current notes and insights |

The server without credentials still serves data and retrieval-only answers
through the API (useful for development and tests).

## Session data

The browser keeps each session in `localStorage`, keyed by case, role and mode.
*Export session* downloads notes, gaps, insights, chat threads, the structured
view and a timestamped event log (gap selections, questions, saves, edits,
resolutions). For studies, `SPARRING_ACCEPT_SESSION_LOGS=1` enables
`POST /api/sessions`, which stores posted sessions under `sessions/`.
