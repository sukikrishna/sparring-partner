import json

from sparring_partner import agents
from sparring_partner.agents import chat, gaps
from sparring_partner.agents.structure import heuristic_structure
from sparring_partner.agents.common import anchor_quote, history_messages
from sparring_partner.llm import StubLLMClient
from sparring_partner.schemas import (
    CaseAnswer,
    ChatTurn,
    Citation,
    DocAnswer,
    FrameItem,
    Gap,
    GapSet,
    Insight,
    IslandOfAgreement,
    PartyView,
    StructuredView,
)

NOTES = (
    "honestly the stadium might be ok. BA pays 6 SD per person per day so that should mostly cover it.\n\n"
    "police can handle gathering people at the stadium."
)

# A sentence that only appears in the Border Authority officer's restricted instructions.
OFFICER_ONLY = "possibly as many as one in five"


def _gap(**kw):
    base = dict(
        quote="BA pays 6 SD per person per day so that should mostly cover it.",
        title="Costs covered",
        question="What would it cost?",
        assumption="Compensation covers costs.",
        lens="Resources",
        doc_ids=["finance-memo"],
        severity="high",
    )
    base.update(kw)
    return Gap(**base)


# ------------------------------------------------------------- quote anchoring


def test_anchor_quote_exact_and_whitespace():
    assert anchor_quote("police can handle gathering people", NOTES) == "police can handle gathering people"
    assert anchor_quote("police  can\nhandle gathering people", NOTES) == "police can handle gathering people"


def test_anchor_quote_fuzzy_sentence():
    fixed = anchor_quote("BA pays 6 SD per person per day so this should mostly cover it", NOTES)
    assert fixed == "BA pays 6 SD per person per day so that should mostly cover it."


def test_anchor_quote_rejects_invented_text():
    assert anchor_quote("We will walk away if they refuse", NOTES) is None


def test_history_alternates():
    msgs = history_messages(
        [ChatTurn(role="assistant", content="hi"), ChatTurn(role="user", content="a"), ChatTurn(role="user", content="b")]
    )
    roles = [m["role"] for m in msgs]
    assert roles == ["user", "assistant", "user", "assistant"]
    assert msgs[2]["content"] == "a\n\nb"


# ------------------------------------------------------------------ gaps


def test_find_gaps_postprocesses(qiso):
    stub = StubLLMClient(
        {
            GapSet: lambda call: GapSet(
                gaps=[
                    _gap(severity="medium"),
                    _gap(quote="police can handle gathering people at the stadium", doc_ids=["hq-instructions", "police-memo"]),
                    _gap(quote="This sentence is not in the notes at all."),
                    _gap(quote="BA pays 6 SD per person per day so that should mostly cover it."),  # duplicate
                    _gap(quote="police can handle gathering", doc_ids=["hq-instructions"]),  # only invisible docs
                ]
            )
        }
    )
    out = agents.find_gaps(stub, qiso, qiso.role("mayor"), NOTES, max_gaps=4)
    assert [g.quote for g in out] == [
        "police can handle gathering people at the stadium",
        "BA pays 6 SD per person per day so that should mostly cover it.",
    ]
    assert out[0].doc_ids == ["police-memo"]  # invisible document dropped
    for g in out:
        assert g.quote in NOTES


def test_gap_prompt_contains_only_visible_documents(qiso):
    """Information barrier: the mayor's prompt never includes the officer's private documents."""
    mayor_prompt = json.dumps(gaps.build_messages(qiso, qiso.role("mayor"), NOTES, 4))
    officer_prompt = json.dumps(gaps.build_messages(qiso, qiso.role("border-officer"), NOTES, 4))
    assert OFFICER_ONLY not in mayor_prompt
    assert OFFICER_ONLY in officer_prompt  # positive control
    assert "Weekly shortfall" in mayor_prompt and "Weekly shortfall" not in officer_prompt


def test_case_chat_prompt_respects_barrier(qiso):
    passages = chat.retrieve_for_case_chat(qiso, qiso.role("mayor"), "military-age men armed groups one in five", [])
    msgs = json.dumps(chat.build_case_messages(qiso, qiso.role("mayor"), NOTES, passages, [], "q"))
    assert OFFICER_ONLY not in msgs


# ------------------------------------------------------------------ chats


def test_doc_chat_filters_bad_citations(qiso):
    doc = qiso.document("police-memo", "mayor")
    stub = StubLLMClient(
        {DocAnswer: lambda c: DocAnswer(answer="22 officers.", cited_paragraphs=[6, 6, 99, 0], key_finding="k", follow_ups=["a", "b", "c"])}
    )
    ans = agents.doc_chat(stub, qiso, qiso.role("mayor"), doc, "How many officers?")
    assert ans.cited_paragraphs == [6]
    assert len(ans.follow_ups) == 2
    first = stub.calls[0]["messages"][0]["content"][0]
    assert first["cache_control"] == {"type": "ephemeral"}
    assert "22 sworn officers" in first["text"]


def test_case_chat_filters_citations_to_visible_docs(qiso):
    stub = StubLLMClient(
        {
            CaseAnswer: lambda c: CaseAnswer(
                answer="x",
                citations=[
                    Citation(doc_id="finance-memo", paragraph=27),
                    Citation(doc_id="finance-memo", paragraph=27),
                    Citation(doc_id="hq-instructions", paragraph=1),
                    Citation(doc_id="finance-memo", paragraph=500),
                ],
                key_finding=None,
                follow_ups=[],
            )
        }
    )
    ans = agents.case_chat(stub, qiso, qiso.role("mayor"), "When is compensation paid?")
    assert [(c.doc_id, c.paragraph) for c in ans.citations] == [("finance-memo", 27)]


def test_offline_answers_are_extractive(qiso):
    doc = qiso.document("finance-memo", "mayor")
    ans = agents.doc_chat(None, qiso, qiso.role("mayor"), doc, "compensation paid after 90 days")
    assert 27 in ans.cited_paragraphs
    assert ans.key_finding is None
    case_ans = agents.case_chat(None, qiso, qiso.role("mayor"), "how many sworn officers")
    assert case_ans.citations


# -------------------------------------------------------------- structure


def _view(**overrides):
    empty = []
    view = dict(
        objective=[FrameItem(text="Keep calm", basis="notes", ref="stadium might be ok")],
        parties=[PartyView(party="You", position=[], interests=[FrameItem(text="x", basis="insight", ref="nope")], values=[])],
        island_of_agreement=IslandOfAgreement(convergent_facts=empty, contested_facts=empty, shared_norms=empty, divergent_norms=empty),
        stakeholders=[FrameItem(text="Police", basis="notes", ref="not actually in notes")],
        red_lines=[],
        alternatives=[],
        options=[FrameItem(text="i", basis="insight", ref="ins-1")],
        open_questions=[],
    )
    view.update(overrides)
    return StructuredView(**view)


def test_structure_verifies_provenance(qiso):
    stub = StubLLMClient({StructuredView: lambda c: _view()})
    insights = [Insight(id="ins-1", text="t", author="ai", origin="doc-chat")]
    view = agents.structure(stub, qiso, qiso.role("mayor"), NOTES, insights)
    assert view.objective[0].ref == "stadium might be ok"
    assert view.parties[0].interests[0].basis == "framework"  # unknown insight id downgraded
    assert view.stakeholders[0].ref == ""  # ref not found in notes cleared
    assert view.options[0].basis == "insight"
    assert '<insight id="ins-1"' in stub.calls[0]["messages"][0]["content"][1]["text"]


def test_heuristic_structure_never_invents():
    from sparring_partner.schemas import Role

    role = Role(id="r", name="Mayor", brief="", counterpart="officer")
    view = heuristic_structure(role, "What I want: keep families together. We will never use force.", [])
    assert any("keep families together" in i.text for i in view.objective)
    assert any("never use force" in i.text for i in view.red_lines)
    assert all(i.basis == "framework" for i in view.open_questions)
