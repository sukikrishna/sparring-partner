"""Gap finder: flags passages in the negotiator's notes that rest on an
assumption the case documents call into question.

Each gap is anchored to an exact span of the notes (so the editor can
highlight it), framed as a question rather than a verdict, and linked to the
documents the negotiator should read.
"""

from __future__ import annotations

from ..llm import LLMClient, LLMError, cached_block
from ..schemas import Case, Gap, GapSet, Role
from .common import PRINCIPLES, anchor_quote, format_documents, normalize, role_header

SYSTEM = (
    PRINCIPLES
    + """
Task: read the negotiator's working notes against the case documents and find the passages whose \
reasoning most needs another look before the negotiation.

A good gap:
- is a load-bearing assumption: if it is wrong, the negotiator's plan fails, costs them leverage, \
or harms someone. Typical lenses: facts (numbers, who said what), the counterpart's or a \
stakeholder's interests, the negotiator's real resources and capacity, alternatives if talks \
fail, red lines, process and sequencing, relationships and trust;
- is contradicted, complicated or left unsupported by specific passages in the documents you can \
point to;
- is phrased as one probing question that makes the negotiator check the evidence themselves. Do \
not give the answer, do not say what the documents say, do not tell them what to do.

Rules:
- `quote` must be copied verbatim from the notes (an exact substring, one sentence or clause).
- Each quote must be distinct; do not flag the same passage twice.
- Only cite document ids from the provided documents.
- Order gaps by severity. Prefer fewer, sharper gaps over many weak ones.
"""
)


def build_messages(case: Case, role: Role, notes: str, max_gaps: int) -> list[dict]:
    docs = case.visible_documents(role.id)
    return [
        {
            "role": "user",
            "content": [
                cached_block(role_header(case, role) + "\n\nCase documents:\n\n" + format_documents(docs)),
                {
                    "type": "text",
                    "text": f"The negotiator's working notes:\n<notes>\n{notes}\n</notes>\n\n"
                    f"Return at most {max_gaps} gaps.",
                },
            ],
        }
    ]


def postprocess(result: GapSet, case: Case, role: Role, notes: str, max_gaps: int) -> list[Gap]:
    """Anchor quotes to the notes, drop invalid citations and duplicates."""
    visible = {d.id for d in case.visible_documents(role.id)}
    seen: set[str] = set()
    gaps: list[Gap] = []
    for gap in result.gaps:
        quote = anchor_quote(gap.quote, notes)
        if not quote or normalize(quote).lower() in seen:
            continue
        doc_ids = [d for d in gap.doc_ids if d in visible]
        if not doc_ids:
            continue
        seen.add(normalize(quote).lower())
        gaps.append(gap.model_copy(update={"quote": quote, "doc_ids": doc_ids[:3]}))
    rank = {"high": 0, "medium": 1, "low": 2}
    gaps.sort(key=lambda g: rank[g.severity])
    return gaps[:max_gaps]


def find_gaps(llm: LLMClient | None, case: Case, role: Role, notes: str, max_gaps: int = 4) -> list[Gap]:
    if not notes.strip():
        return []
    if llm is None:
        raise LLMError("Finding gaps needs a language model. Set ANTHROPIC_API_KEY or use the scripted demo.")
    result = llm.parse(
        task="gaps",
        system=SYSTEM,
        messages=build_messages(case, role, notes, max_gaps),
        output_format=GapSet,
    )
    return postprocess(result, case, role, notes, max_gaps)
