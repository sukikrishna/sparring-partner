"""The two chats that generate AI insights.

- Document chat ("rabbit hole"): scoped to one document, aware of the
  negotiator's notes and, optionally, the gap that led them there. Its
  history never leaks into other chats.
- Case chat: answers across every document the role can see, using
  retrieval. This is where general, non-gap insights come from.

Both return an optional ``key_finding``: a one-sentence, self-contained
insight the frontend can save to the synthesis board, with provenance.
"""

from __future__ import annotations

from .. import config
from ..llm import LLMClient, cached_block
from ..retrieval import BM25Index, Passage, index_for
from ..schemas import CaseAnswer, ChatTurn, Citation, DocAnswer, Document, GapRef, Case, Role
from .common import PRINCIPLES, format_document, history_messages, role_header

# =============================================================================
# Document chat
# =============================================================================

DOC_SYSTEM = (
    PRINCIPLES
    + """
Task: answer the negotiator's questions about ONE open document. Use only that document. Cite the \
paragraph numbers ([n]) you rely on. If the document does not address the question, say so plainly \
and suggest what kind of source might.

If the negotiator came here from a flagged passage in their notes, help them test that passage \
against this document, but let them draw the conclusion.

`key_finding`: one sentence a busy negotiator could act on later, understandable without the chat \
(name the source, e.g. "The finance memo estimates..."). Null if nothing new was found.
"""
)


def build_doc_messages(
    case: Case,
    role: Role,
    doc: Document,
    notes: str,
    gap: GapRef | None,
    history: list[ChatTurn],
    question: str,
) -> list[dict]:
    context = f"The negotiator's current notes:\n<notes>\n{notes or '(empty)'}\n</notes>"
    if gap:
        context += (
            f"\n\nThey opened this document from this flagged passage:\n<passage>{gap.quote}</passage>"
            + (f"\nQuestion raised about it: {gap.question}" if gap.question else "")
        )
    first = {
        "role": "user",
        "content": [
            cached_block(role_header(case, role) + "\n\nThe open document:\n\n" + format_document(doc)),
            {"type": "text", "text": context},
        ],
    }
    ack = {"role": "assistant", "content": "Understood. I will answer from this document only."}
    return [first, ack, *history_messages(history), {"role": "user", "content": question}]


def doc_chat(
    llm: LLMClient | None,
    case: Case,
    role: Role,
    doc: Document,
    question: str,
    notes: str = "",
    gap: GapRef | None = None,
    history: list[ChatTurn] | None = None,
) -> DocAnswer:
    if llm is None:
        return _offline_doc_answer(doc, question)
    answer = llm.parse(
        task="doc_chat",
        system=DOC_SYSTEM,
        messages=build_doc_messages(case, role, doc, notes, gap, history or [], question),
        output_format=DocAnswer,
    )
    valid = [n for n in answer.cited_paragraphs if 1 <= n <= len(doc.paragraphs)]
    return answer.model_copy(update={"cited_paragraphs": sorted(set(valid)), "follow_ups": answer.follow_ups[:2]})


def _excerpt(text: str, limit: int = 220) -> str:
    return text if len(text) <= limit else text[: limit - 1].rsplit(" ", 1)[0] + "…"


def _offline_doc_answer(doc: Document, question: str) -> DocAnswer:
    hits = BM25Index.from_documents([doc]).search(question, k=3)
    if not hits:
        return DocAnswer(
            answer="No language model is configured, and no paragraph in this document matches your "
            "question's keywords. Try different words, or read the document directly.",
            cited_paragraphs=[],
            key_finding=None,
            follow_ups=[],
        )
    lines = [f"[{h.paragraph}] {_excerpt(h.text)}" for h in hits]
    return DocAnswer(
        answer="No language model is configured, so here are the passages in this document that best "
        "match your question:\n" + "\n".join(lines),
        cited_paragraphs=sorted(h.paragraph for h in hits),
        key_finding=None,
        follow_ups=[],
    )


# =============================================================================
# Case chat
# =============================================================================

CASE_SYSTEM = (
    PRINCIPLES
    + """
Task: answer the negotiator's question using the retrieved passages from their case documents. \
Each passage is labelled with a document id and paragraph number. Cite every passage you rely on \
in `citations`. Point out where sources disagree. If the passages do not answer the question, say \
so; do not fill the gap from general knowledge.

`key_finding`: one self-contained sentence worth saving (name the sources), or null.
"""
)


def format_passages(passages: list[Passage]) -> str:
    return "\n\n".join(
        f'<passage doc="{p.doc_id}" title="{p.doc_title}" paragraph="{p.paragraph}">\n{p.text}\n</passage>'
        for p in passages
    )


def retrieve_for_case_chat(case: Case, role: Role, question: str, history: list[ChatTurn]) -> list[Passage]:
    # Fold in the previous user turn so follow-ups like "and the police?" still retrieve well.
    recent = [t.content for t in history if t.role == "user"][-1:]
    query = " ".join(recent + [question])
    return index_for(case, role.id).search(query, k=config.CASE_CHAT_K)


def build_case_messages(
    case: Case,
    role: Role,
    notes: str,
    passages: list[Passage],
    history: list[ChatTurn],
    question: str,
) -> list[dict]:
    first = {
        "role": "user",
        "content": [
            cached_block(role_header(case, role)),
            {"type": "text", "text": f"The negotiator's current notes:\n<notes>\n{notes or '(empty)'}\n</notes>"},
        ],
    }
    ack = {"role": "assistant", "content": "Understood."}
    final = {
        "role": "user",
        "content": "Retrieved passages:\n\n" + (format_passages(passages) or "(none)") + f"\n\nQuestion: {question}",
    }
    return [first, ack, *history_messages(history), final]


def case_chat(
    llm: LLMClient | None,
    case: Case,
    role: Role,
    question: str,
    notes: str = "",
    history: list[ChatTurn] | None = None,
) -> CaseAnswer:
    history = history or []
    passages = retrieve_for_case_chat(case, role, question, history)
    if llm is None:
        return _offline_case_answer(passages)
    answer = llm.parse(
        task="case_chat",
        system=CASE_SYSTEM,
        messages=build_case_messages(case, role, notes, passages, history, question),
        output_format=CaseAnswer,
    )
    visible = {d.id: len(d.paragraphs) for d in case.visible_documents(role.id)}
    citations = [c for c in answer.citations if c.doc_id in visible and 1 <= c.paragraph <= visible[c.doc_id]]
    unique = list({(c.doc_id, c.paragraph): c for c in citations}.values())
    return answer.model_copy(update={"citations": unique, "follow_ups": answer.follow_ups[:2]})


def _offline_case_answer(passages: list[Passage]) -> CaseAnswer:
    top = passages[:4]
    if not top:
        return CaseAnswer(
            answer="No language model is configured, and no passage matches your question's keywords.",
            citations=[],
            key_finding=None,
            follow_ups=[],
        )
    lines = [f"{p.doc_title} [{p.paragraph}]: {_excerpt(p.text)}" for p in top]
    return CaseAnswer(
        answer="No language model is configured, so here are the best-matching passages across your "
        "documents:\n" + "\n".join(lines),
        citations=[Citation(doc_id=p.doc_id, paragraph=p.paragraph) for p in top],
        key_finding=None,
        follow_ups=[],
    )
