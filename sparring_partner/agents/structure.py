"""Structurer: restates the negotiator's free-flow notes (plus any insights
they saved) in negotiation-framework terms.

This addresses a core design tension: the Human-Only space should accept
messy, unformatted thinking, while the synthesis board should present it in
a form that supports negotiation reasoning. The structurer may rephrase and
organize but not add substance. Every item carries its basis: restated from
the notes (with the phrase it restates), taken from a saved insight (with its
id), or a framework prompt the notes leave open.

Frameworks used (common in humanitarian frontline negotiation training):
- Iceberg: each party's position (what), interests (why), values (norms).
- Island of agreement: convergent vs contested facts, shared vs divergent norms.
- Stakeholder influence, red lines, alternatives to agreement (BATNA), options.
"""

from __future__ import annotations

import re

from ..llm import LLMClient, cached_block
from ..schemas import Case, FrameItem, Insight, IslandOfAgreement, PartyView, Role, StructuredView
from .common import PRINCIPLES, normalize, role_header, sentences

SYSTEM = (
    PRINCIPLES
    + """
Task: restate the negotiator's free-flow notes, and the insights they chose to save, in a \
structured negotiation-preparation format:
- objective: what the negotiator is trying to achieve;
- parties: an iceberg for each party (their own side first, then the counterpart, then others \
the notes discuss): position (what they demand), interests (why), values (underlying norms);
- island_of_agreement: facts both sides would accept, facts in dispute, norms both share, norms \
that diverge;
- stakeholders: who can influence the counterpart or the outcome, and how;
- red_lines, alternatives (what happens if no agreement), options (possible trades);
- open_questions: what the framework asks that the notes and insights do not yet answer.

Hard rules:
- Do not add substance. Every item must come from the notes (basis "notes", ref = the short \
verbatim phrase it restates) or from a saved insight (basis "insight", ref = its id). You may \
infer a party's interest only when the notes or an insight state it.
- Anything the framework needs but the inputs do not supply goes in open_questions with basis \
"framework" and an empty ref. Leave other sections empty rather than guessing.
- Use crisp, neutral phrasing; one idea per item.
"""
)


def build_messages(case: Case, role: Role, notes: str, insights: list[Insight]) -> list[dict]:
    saved = "\n".join(
        f'<insight id="{i.id}" author="{i.author}" origin="{i.origin}">{i.text}</insight>' for i in insights
    )
    return [
        {
            "role": "user",
            "content": [
                cached_block(role_header(case, role)),
                {
                    "type": "text",
                    "text": f"<notes>\n{notes}\n</notes>\n\nSaved insights:\n{saved or '(none)'}",
                },
            ],
        }
    ]


def _check_refs(view: StructuredView, notes: str, insights: list[Insight]) -> StructuredView:
    """Downgrade items whose provenance cannot be verified to framework prompts."""
    ids = {i.id for i in insights}
    n = normalize(notes).lower()

    def fix(items: list[FrameItem]) -> list[FrameItem]:
        out = []
        for it in items:
            if it.basis == "insight" and it.ref not in ids:
                it = it.model_copy(update={"basis": "framework", "ref": ""})
            elif it.basis == "notes" and it.ref and normalize(it.ref).lower() not in n:
                it = it.model_copy(update={"ref": ""})
            out.append(it)
        return out

    data = view.model_copy(deep=True)
    for field in ("objective", "stakeholders", "red_lines", "alternatives", "options", "open_questions"):
        setattr(data, field, fix(getattr(data, field)))
    for party in data.parties:
        party.position, party.interests, party.values = fix(party.position), fix(party.interests), fix(party.values)
    ioa = data.island_of_agreement
    for field in ("convergent_facts", "contested_facts", "shared_norms", "divergent_norms"):
        setattr(ioa, field, fix(getattr(ioa, field)))
    return data


def structure(llm: LLMClient | None, case: Case, role: Role, notes: str, insights: list[Insight]) -> StructuredView:
    if llm is None:
        return heuristic_structure(role, notes, insights)
    view = llm.parse(
        task="structure",
        system=SYSTEM,
        messages=build_messages(case, role, notes, insights),
        output_format=StructuredView,
    )
    return _check_refs(view, notes, insights)


# =============================================================================
# Offline fallback: keyword rules. Crude, but transparent and never invents.
# =============================================================================

_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("objective", re.compile(r"\b(i|we) (actually )?(want|need|aim)|\bgoal\b|\bobjective\b|\bwhat i want", re.I)),
    ("red_lines", re.compile(r"\b(won't|will not|never|cannot|can't|must not|red ?line|non-negotiable)\b", re.I)),
    ("alternatives", re.compile(r"\b(walk away|fallback|plan b|otherwise|if (they|he|she) (refuse|say no))\b", re.I)),
    ("options", re.compile(r"\b(maybe|could|offer|propose|trade|in exchange|might)\b", re.I)),
]


def heuristic_structure(role: Role, notes: str, insights: list[Insight]) -> StructuredView:
    buckets: dict[str, list[FrameItem]] = {k: [] for k, _ in _RULES}
    other: list[FrameItem] = []
    for sent in sentences(notes):
        item = FrameItem(text=sent.rstrip(".") + ".", basis="notes", ref=sent[:80])
        for key, pattern in _RULES:
            if pattern.search(sent):
                buckets[key].append(item)
                break
        else:
            other.append(item)

    open_q: list[FrameItem] = []
    prompts = {
        "objective": "What, concretely, would a good outcome look like for you?",
        "red_lines": "Which points can you not concede under any circumstances?",
        "alternatives": "What will you do if no agreement is reached?",
        "options": "What could you offer that costs you little but matters to the counterpart?",
    }
    for key, prompt in prompts.items():
        if not buckets[key]:
            open_q.append(FrameItem(text=prompt, basis="framework", ref=""))
    open_q.append(
        FrameItem(
            text=f"What does the {role.counterpart or 'counterpart'} need, beyond what they are asking for?",
            basis="framework",
            ref="",
        )
    )

    ai_items = [FrameItem(text=i.text, basis="insight", ref=i.id) for i in insights]
    return StructuredView(
        objective=buckets["objective"],
        parties=[PartyView(party=f"You ({role.name})", position=other, interests=[], values=[])],
        island_of_agreement=IslandOfAgreement(
            convergent_facts=[], contested_facts=ai_items, shared_norms=[], divergent_norms=[]
        ),
        stakeholders=[],
        red_lines=buckets["red_lines"],
        alternatives=buckets["alternatives"],
        options=buckets["options"],
        open_questions=open_q,
    )
