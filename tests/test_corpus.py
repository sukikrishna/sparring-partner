"""Checks on the built corpora shipped in web/data/cases."""

import pytest

from sparring_partner import config
from sparring_partner.corpus import list_cases, load_case

CASES = [c["id"] for c in list_cases()]


def test_index_matches_files():
    files = {p.stem for p in config.CORPUS_DIR.glob("*.json") if p.name != "index.json"}
    assert set(CASES) == files


@pytest.mark.parametrize("case_id", CASES)
def test_case_is_well_formed(case_id):
    case = load_case(case_id)
    role_ids = {r.id for r in case.roles}
    assert len(role_ids) >= 2
    for d in case.documents:
        assert d.paragraphs, d.id
        assert set(d.visible_to) <= role_ids, d.id
    for r in case.roles:
        assert case.visible_documents(r.id), r.id


@pytest.mark.parametrize("case_id", CASES)
def test_every_role_has_private_documents(case_id):
    """Role-play cases depend on information asymmetry between the parties."""
    case = load_case(case_id)
    for r in case.roles:
        private = [d for d in case.documents if d.visible_to == [r.id]]
        assert private, f"{case_id}/{r.id} has no private documents"


def test_qiso_barrier(qiso):
    mayor = {d.id for d in qiso.visible_documents("mayor")}
    officer = {d.id for d in qiso.visible_documents("border-officer")}
    assert "finance-memo" in mayor and "finance-memo" not in officer
    assert "hq-instructions" in officer and "hq-instructions" not in mayor
    assert "protocols" in mayor & officer

