"""The scripted demo is hand-written; these checks keep it honest against the corpus."""

import json
from pathlib import Path

import pytest

from sparring_partner.agents.common import normalize
from sparring_partner.corpus import load_case

ROOT = Path(__file__).resolve().parent.parent
DEMO_DIR = ROOT / "web" / "data" / "demo"
DEMOS = sorted(p for p in DEMO_DIR.glob("*.json") if p.name != "index.json")


def test_demo_index_lists_every_script():
    listed = set(json.loads((DEMO_DIR / "index.json").read_text())["scripts"])
    assert listed == {p.stem for p in DEMOS}


@pytest.fixture(params=DEMOS, ids=[p.stem for p in DEMOS])
def demo(request):
    return json.loads(request.param.read_text())


def _visible(demo):
    case = load_case(demo["case_id"])
    role = case.role(demo["role_id"])
    return case, role, {d.id: d for d in case.visible_documents(role.id)}


def test_gap_quotes_are_in_starter_notes(demo):
    _, role, _ = _visible(demo)
    for gap in demo["gaps"]:
        assert gap["quote"] in role.starter_notes, gap["id"]


def test_gap_documents_are_visible(demo):
    _, _, docs = _visible(demo)
    for gap in demo["gaps"]:
        for doc_id in gap["doc_ids"]:
            assert doc_id in docs, (gap["id"], doc_id)


def test_doc_answers_cite_real_paragraphs(demo):
    _, _, docs = _visible(demo)
    gap_ids = {g["id"] for g in demo["gaps"]}
    ids = set()
    for doc_id, entries in demo["doc_qa"].items():
        assert doc_id in docs, doc_id
        for qa in entries:
            assert qa["id"] not in ids, f"duplicate id {qa['id']}"
            ids.add(qa["id"])
            assert qa["cites"], qa["id"]
            for n in qa["cites"]:
                assert 1 <= n <= len(docs[doc_id].paragraphs), (qa["id"], n)
            assert set(qa["gaps"]) <= gap_ids, qa["id"]


def test_every_gap_document_has_scripted_questions(demo):
    for gap in demo["gaps"]:
        assert gap["doc_ids"][0] in demo["doc_qa"], gap["id"]


def test_case_answers_cite_real_paragraphs(demo):
    _, _, docs = _visible(demo)
    for qa in demo["case_qa"]:
        for c in qa["citations"]:
            assert c["doc_id"] in docs, (qa["id"], c)
            assert 1 <= c["paragraph"] <= len(docs[c["doc_id"]].paragraphs), (qa["id"], c)


def test_structured_view_refs_come_from_notes(demo):
    _, role, _ = _visible(demo)
    notes = normalize(role.starter_notes).lower()
    view = demo["structured"]
    items = []
    for key in ("objective", "stakeholders", "red_lines", "alternatives", "options", "open_questions"):
        items += view[key]
    for party in view["parties"]:
        items += party["position"] + party["interests"] + party["values"]
    for key, value in view["island_of_agreement"].items():
        items += value
    for item in items:
        if item["basis"] == "notes":
            assert normalize(item["ref"]).lower() in notes, item["ref"]
        if item["basis"] == "framework":
            assert item["ref"] == ""
