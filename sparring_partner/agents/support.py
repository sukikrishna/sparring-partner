"""Support finder: marks passages in the negotiator's notes that the case
documents plainly confirm.

The counterpart of the gap finder. Each passage is anchored to an exact span of
the notes (so the editor can highlight it) and carries the document paragraphs
that back it. There is no verdict to argue with and nothing to fix, so the
negotiator just sees which of their claims stand on solid ground.
"""

from __future__ import annotations

from ..llm import LLMClient, cached_block
from ..schemas import Case, Citation, Role, SupportedPassage, SupportSet
from .common import PRINCIPLES, anchor_quote, format_documents, normalize, role_header

SYSTEM = (
    PRINCIPLES
    + """
Task: find the passages in the negotiator's working notes whose factual claims the case documents \
clearly confirm.

A supported passage:
- states a fact (a figure, who said or did something, a rule or requirement, a date, a place) that \
one or more documents state plainly, so that you can point to the exact paragraph;
- is quoted as narrowly as possible: only the clause the documents confirm. If part of a sentence \
is unsupported, contradicted or only the negotiator's opinion, leave that part out of the quote.

Be conservative. Do NOT mark:
- opinions, predictions, plans or wishes;
- anything the documents contradict, complicate, qualify or are silent about;
- anything only a rumour, a social-media post or a clearly partisan source asserts.

Rules:
- `quote` must be copied verbatim from the notes (an exact substring).
- Each quote must be distinct. Only cite document ids from the provided documents, with the \
paragraph numbers shown in square brackets.
- It is fine to return few passages, or none.
"""
)


def build_messages(case: Case, role: Role, notes: str, max_passages: int) -> list[dict]:
    docs = case.visible_documents(role.id)
    return [
        {
            "role": "user",
            "content": [
                cached_block(role_header(case, role) + "\n\nCase documents:\n\n" + format_documents(docs)),
                {
                    "type": "text",
                    "text": f"The negotiator's working notes:\n<notes>\n{notes}\n</notes>\n\n"
                    f"Return at most {max_passages} supported passages.",
                },
            ],
        }
    ]


def postprocess(result: SupportSet, case: Case, role: Role, notes: str, max_passages: int) -> list[SupportedPassage]:
    """Anchor quotes to the notes; keep only citations to paragraphs the role can see."""
    visible = {d.id: d for d in case.visible_documents(role.id)}
    seen: set[str] = set()
    passages: list[SupportedPassage] = []
    for passage in result.passages:
        quote = anchor_quote(passage.quote, notes)
        if not quote or normalize(quote).lower() in seen:
            continue
        citations: list[Citation] = []
        for c in passage.citations:
            doc = visible.get(c.doc_id)
            if doc and 1 <= c.paragraph <= len(doc.paragraphs) and c not in citations:
                citations.append(c)
        if not citations:
            continue
        seen.add(normalize(quote).lower())
        passages.append(passage.model_copy(update={"quote": quote, "citations": citations[:2]}))
    return passages[:max_passages]


def find_supported(
    llm: LLMClient | None, case: Case, role: Role, notes: str, max_passages: int = 6
) -> list[SupportedPassage]:
    """Passages of the notes the documents confirm. Optional extra: empty without a model."""
    if llm is None or not notes.strip():
        return []
    result = llm.parse(
        task="support",
        system=SYSTEM,
        messages=build_messages(case, role, notes, max_passages),
        output_format=SupportSet,
    )
    return postprocess(result, case, role, notes, max_passages)
