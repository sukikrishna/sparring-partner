"""Recheck: after the negotiator edits a flagged passage, decide whether the
revision still rests on the flagged assumption.

The frontend already clears a highlight when the wording changes a lot; this
agent handles the harder case where the wording changed but the assumption
did not (or vice versa).
"""

from __future__ import annotations

from ..llm import LLMClient
from ..schemas import Case, GapRef, RecheckResult, Role
from .common import PRINCIPLES, role_header, similarity

SYSTEM = (
    PRINCIPLES
    + """
Task: a passage in the negotiator's notes was flagged because it rested on a questionable \
assumption. They have revised it. Decide whether the revised passage still relies on that \
assumption. Count it as resolved if the assumption was dropped, qualified with evidence, or turned \
into an explicit open question or contingency. Do not judge whether the new plan is good.
"""
)


def recheck(
    llm: LLMClient | None, case: Case, role: Role, gap: GapRef, revised: str, notes: str = ""
) -> RecheckResult:
    if llm is None:
        sim = similarity(gap.quote, revised)
        return RecheckResult(
            resolved=sim < 0.6,
            explanation="Wording changed substantially." if sim < 0.6 else "The passage is largely unchanged.",
        )
    msg = (
        role_header(case, role)
        + f"\n\nOriginal flagged passage:\n<original>{gap.quote}</original>"
        + (f"\nAssumption it relied on: {gap.assumption}" if gap.assumption else "")
        + (f"\nQuestion raised: {gap.question}" if gap.question else "")
        + f"\n\nRevised passage:\n<revised>{revised or '(deleted)'}</revised>"
    )
    return llm.parse(
        task="recheck",
        system=SYSTEM,
        messages=[{"role": "user", "content": msg}],
        output_format=RecheckResult,
    )
