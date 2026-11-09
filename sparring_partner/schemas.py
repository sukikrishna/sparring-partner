"""Data models: the case corpus, agent outputs, and API payloads.

Agent output models are passed to Claude as structured-output schemas, so
their field descriptions double as instructions. Keep them precise.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# =============================================================================
# Corpus
# =============================================================================


class Document(BaseModel):
    id: str
    title: str
    kind: str = Field(description="Short genre label, e.g. 'Memo', 'Group chat', 'News'.")
    #: Role ids that may see this document. Shared documents list every role.
    visible_to: list[str]
    paragraphs: list[str]
    source: str = Field(default="", description="Path of the raw file, relative to the raw dir.")


class Role(BaseModel):
    id: str
    name: str
    #: Who the user is in this role and what they are preparing for.
    brief: str
    counterpart: str = ""
    #: Starting notes shown in the Human-Only editor for this role (may be empty).
    starter_notes: str = ""


class Case(BaseModel):
    id: str
    title: str
    summary: str
    roles: list[Role]
    documents: list[Document]

    def role(self, role_id: str) -> Role:
        for r in self.roles:
            if r.id == role_id:
                return r
        raise KeyError(f"case {self.id!r} has no role {role_id!r}")

    def visible_documents(self, role_id: str) -> list[Document]:
        """The information barrier: only documents this role is allowed to see."""
        self.role(role_id)  # validate
        return [d for d in self.documents if role_id in d.visible_to]

    def document(self, doc_id: str, role_id: str) -> Document:
        for d in self.visible_documents(role_id):
            if d.id == doc_id:
                return d
        raise KeyError(f"document {doc_id!r} is not visible to role {role_id!r}")


# =============================================================================
# Agent outputs
# =============================================================================

Lens = Literal[
    "Facts",
    "Interests",
    "Stakeholders",
    "Leverage",
    "Alternatives",
    "Red lines",
    "Resources",
    "Process",
    "Relationship",
]


class Gap(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quote: str = Field(
        description="An EXACT, verbatim substring of the negotiator's notes (one sentence or clause) "
        "that contains the questionable assumption. Copy characters exactly; do not paraphrase."
    )
    title: str = Field(description="3-7 word label for the gap, e.g. 'Stadium costs are covered'.")
    question: str = Field(
        description="A single probing question that leads the negotiator to examine the assumption "
        "themselves. Do not state the answer."
    )
    assumption: str = Field(description="The assumption the passage relies on, stated plainly.")
    lens: Lens = Field(description="Which negotiation lens the gap belongs to.")
    doc_ids: list[str] = Field(
        description="1-3 document ids (from the provided list) that bear on the assumption, most relevant first."
    )
    severity: Literal["high", "medium", "low"]


class GapSet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gaps: list[Gap]


class DocAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    answer: str = Field(description="2-5 sentence answer grounded only in the open document.")
    cited_paragraphs: list[int] = Field(description="1-based paragraph numbers the answer relies on.")
    key_finding: str | None = Field(
        description="One self-contained sentence worth saving to the synthesis board, or null if the "
        "answer contains nothing new or the document is silent."
    )
    follow_ups: list[str] = Field(description="Up to 2 short follow-up questions the negotiator could ask next.")


class Citation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    doc_id: str
    paragraph: int


class CaseAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    answer: str = Field(description="2-6 sentence answer grounded only in the provided passages.")
    citations: list[Citation]
    key_finding: str | None = Field(
        description="One self-contained sentence worth saving to the synthesis board, or null."
    )
    follow_ups: list[str] = Field(description="Up to 2 short follow-up questions.")


Basis = Literal["notes", "insight", "framework"]


class FrameItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    basis: Basis = Field(
        description="'notes' if restated from the negotiator's own notes, 'insight' if taken from a saved "
        "insight, 'framework' if it is a prompt the framework raises that the notes do not answer."
    )
    ref: str = Field(
        description="For 'notes': the short verbatim phrase from the notes it restates. For 'insight': the "
        "insight id. For 'framework': empty string."
    )


class PartyView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    party: str
    position: list[FrameItem] = Field(description="What they say they want (the visible demand).")
    interests: list[FrameItem] = Field(description="Why they want it: needs, concerns, pressures.")
    values: list[FrameItem] = Field(description="Underlying norms, identity, principles.")


class IslandOfAgreement(BaseModel):
    model_config = ConfigDict(extra="forbid")

    convergent_facts: list[FrameItem]
    contested_facts: list[FrameItem]
    shared_norms: list[FrameItem]
    divergent_norms: list[FrameItem]


class StructuredView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    objective: list[FrameItem]
    parties: list[PartyView] = Field(description="Your own side first, then the counterpart, then others.")
    island_of_agreement: IslandOfAgreement
    stakeholders: list[FrameItem] = Field(description="Who influences the counterpart, and how.")
    red_lines: list[FrameItem]
    alternatives: list[FrameItem] = Field(description="What you will do if no agreement is reached (BATNA).")
    options: list[FrameItem] = Field(description="Possible trades or packages the notes mention or imply.")
    open_questions: list[FrameItem] = Field(
        description="Questions the framework raises that the notes and insights leave unanswered."
    )


class RecheckResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    resolved: bool = Field(description="True if the revised text no longer relies on the flagged assumption.")
    explanation: str = Field(description="One sentence on why.")


# =============================================================================
# API payloads
# =============================================================================


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class GapRef(BaseModel):
    """The gap a chat is attached to, if any (chats can also be general)."""

    quote: str
    question: str = ""
    assumption: str = ""


class Insight(BaseModel):
    id: str
    text: str
    author: Literal["human", "ai"]
    origin: str = ""


class GapsRequest(BaseModel):
    case_id: str
    role_id: str
    notes: str
    max_gaps: int = Field(default=4, ge=1, le=8)


class DocChatRequest(BaseModel):
    case_id: str
    role_id: str
    doc_id: str
    notes: str = ""
    gap: GapRef | None = None
    history: list[ChatTurn] = []
    question: str


class CaseChatRequest(BaseModel):
    case_id: str
    role_id: str
    notes: str = ""
    history: list[ChatTurn] = []
    question: str


class StructureRequest(BaseModel):
    case_id: str
    role_id: str
    notes: str
    insights: list[Insight] = []


class RecheckRequest(BaseModel):
    case_id: str
    role_id: str
    gap: GapRef
    revised_passage: str
    notes: str = ""
