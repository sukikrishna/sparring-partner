import json

import pytest

from sparring_partner.ingest import build_case, extract_docx, split_numbered_sources, write_case, write_index

from .conftest import make_docx


def test_extract_docx_paragraphs_and_tables(tmp_path):
    path = make_docx(tmp_path / "a.docx", ["Hello", "  ", "World  twice"], table=[["Item", "Cost"], ["Food", "9"]])
    assert extract_docx(path) == ["Hello", "World twice", "Item | Cost", "Food | 9"]


def test_split_numbered_sources():
    paras = ["Intro text.", "1. Source: Report of the WHO", "Body one.", "2. Source: Meeting with X", "Body two.", "More."]
    sections = split_numbered_sources(paras)
    assert sections == [
        ("Case background", ["Intro text."]),
        ("Report of the WHO", ["Body one."]),
        ("Meeting with X", ["Body two.", "More."]),
    ]


def _manifest(tmp_path, extra=""):
    raw = tmp_path / "raw" / "Case"
    make_docx(raw / "a" / "letter.docx", ["Dear Mayor,", "Header junk", "The stadium is unsafe."])
    make_docx(raw / "b" / "orders.docx", ["Restricted orders."])
    make_docx(raw / "pack.docx", ["Background.", "1. Source: First", "One.", "2. Source: Second", "Two."])
    mdir = tmp_path / "cases" / "demo"
    mdir.mkdir(parents=True)
    (mdir / "notes.txt").write_text("my notes\n")
    (mdir / "manifest.toml").write_text(
        f"""
id = "demo"
title = "Demo"
summary = "A test case."
source_root = "Case"

[[roles]]
id = "a"
name = "Role A"
brief = "You are A."
starter_notes_file = "notes.txt"

[[roles]]
id = "b"
name = "Role B"
brief = "You are B."

[[documents]]
id = "letter"
title = "Letter"
kind = "Letter"
visible_to = ["a", "b"]
source = "a/letter.docx"
drop_leading = 1
fixups = [["Header junk", "Header"]]

[[documents]]
id = "orders"
title = "Orders"
visible_to = ["b"]
source = "b/orders.docx"

[[documents]]
id = "pack"
title = "Pack"
kind = "Report"
visible_to = ["a"]
source = "pack.docx"
split = "numbered-sources"
{extra}
"""
    )
    return mdir / "manifest.toml", tmp_path / "raw"


def test_build_case(tmp_path):
    manifest, raw = _manifest(tmp_path)
    case = build_case(manifest, raw)
    assert case.role("a").starter_notes == "my notes"
    letter = next(d for d in case.documents if d.id == "letter")
    assert letter.paragraphs == ["Header", "The stadium is unsafe."]
    assert [d.id for d in case.documents if d.id.startswith("pack")] == ["pack-00", "pack-01", "pack-02"]
    assert [d.title for d in case.documents if d.id.startswith("pack")] == ["Case background", "First", "Second"]
    assert {d.id for d in case.visible_documents("a")} == {"letter", "pack-00", "pack-01", "pack-02"}
    assert {d.id for d in case.visible_documents("b")} == {"letter", "orders"}


def test_build_case_rejects_unknown_role(tmp_path):
    manifest, raw = _manifest(
        tmp_path,
        extra='\n[[documents]]\nid = "x"\ntitle = "X"\nvisible_to = ["nobody"]\nsource = "b/orders.docx"\n',
    )
    with pytest.raises(ValueError, match="unknown roles"):
        build_case(manifest, raw)


def test_build_case_rejects_missing_file(tmp_path):
    manifest, raw = _manifest(
        tmp_path,
        extra='\n[[documents]]\nid = "x"\ntitle = "X"\nvisible_to = ["a"]\nsource = "missing.docx"\n',
    )
    with pytest.raises(FileNotFoundError):
        build_case(manifest, raw)


def test_write_case_and_index(tmp_path):
    manifest, raw = _manifest(tmp_path)
    out = tmp_path / "out"
    write_case(build_case(manifest, raw), out)
    index = json.loads(write_index(out).read_text())
    assert index["cases"][0]["id"] == "demo"
    assert index["cases"][0]["roles"] == [{"id": "a", "name": "Role A"}, {"id": "b", "name": "Role B"}]
