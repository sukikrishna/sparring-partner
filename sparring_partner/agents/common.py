"""Prompt-formatting helpers shared by the agents."""

from __future__ import annotations

import re
from difflib import SequenceMatcher

from ..schemas import Case, ChatTurn, Document, Role

PRINCIPLES = """\
You are part of Sparring Partner, a tool that helps a negotiator prepare. The tool keeps two \
spaces apart: the negotiator's own strategy (written only by them) and an AI synthesis board. \
Your job is to help the negotiator think, not to think for them:
- Ground every claim in the case documents you are given. Never invent facts, names or numbers. \
If the documents are silent, say so.
- Prefer surfacing evidence and asking a sharp question over prescribing a strategy.
- Be concise and concrete. Plain language; negotiation terms only where they add precision.
- Documents can be one-sided, rumour, or propaganda. Say when a source is unverified or partisan.
"""


def role_header(case: Case, role: Role) -> str:
    return (
        f"Case: {case.title}\n{case.summary}\n\n"
        f"The negotiator's role: {role.name}"
        + (f" (counterpart: {role.counterpart})" if role.counterpart else "")
        + f"\n{role.brief}"
    )


def format_document(doc: Document) -> str:
    body = "\n".join(f"[{i}] {p}" for i, p in enumerate(doc.paragraphs, start=1))
    return f'<document id="{doc.id}" title="{doc.title}" kind="{doc.kind}">\n{body}\n</document>'


def format_documents(docs: list[Document]) -> str:
    return "\n\n".join(format_document(d) for d in docs)


def history_messages(history: list[ChatTurn]) -> list[dict]:
    """Chat history as API messages, dropping turns that would break alternation."""
    out: list[dict] = []
    for turn in history:
        if not turn.content.strip():
            continue
        if out and out[-1]["role"] == turn.role:
            out[-1]["content"] += "\n\n" + turn.content
        else:
            out.append({"role": turn.role, "content": turn.content})
    if out and out[0]["role"] == "assistant":
        out.insert(0, {"role": "user", "content": "(continuing our conversation)"})
    if out and out[-1]["role"] == "user":
        out.append({"role": "assistant", "content": "(noted)"})
    return out


# ---------------------------------------------------------------------------
# Quote anchoring: gaps must point at text that really is in the notes.
# ---------------------------------------------------------------------------


def normalize(text: str) -> str:
    text = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", text).strip()


def sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+|\n+", text)
    return [p.strip() for p in parts if len(p.strip()) > 3]


def anchor_quote(quote: str, notes: str, min_ratio: float = 0.72) -> str | None:
    """Return the exact span of ``notes`` that ``quote`` refers to, or None.

    Exact (whitespace/quote-normalized) matches win; otherwise the most similar
    sentence is used if it is similar enough.
    """
    q = normalize(quote)
    if not q:
        return None
    n = normalize(notes)
    if q in n:
        # Map back onto the original text so the frontend can find it verbatim.
        pattern = r"\s+".join(re.escape(tok) for tok in quote.split())
        m = re.search(pattern, notes)
        if m:
            return m.group(0)
        return q if q in notes else None
    best, best_ratio = None, 0.0
    for sent in sentences(notes):
        ratio = SequenceMatcher(None, normalize(sent).lower(), q.lower()).ratio()
        if ratio > best_ratio:
            best, best_ratio = sent, ratio
    return best if best_ratio >= min_ratio else None


def similarity(a: str, b: str) -> float:
    """Word-set Jaccard similarity, used to decide whether a passage was rewritten."""
    wa = set(re.findall(r"\w+", a.lower()))
    wb = set(re.findall(r"\w+", b.lower()))
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)
