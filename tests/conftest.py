import zipfile
from pathlib import Path

import pytest

from sparring_partner import llm
from sparring_partner.corpus import load_case

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def make_docx(path: Path, paragraphs: list[str], table: list[list[str]] | None = None) -> Path:
    """Write a minimal .docx with the given paragraphs (and optional table)."""
    body = "".join(f"<w:p><w:r><w:t xml:space='preserve'>{p}</w:t></w:r></w:p>" for p in paragraphs)
    if table:
        rows = "".join(
            "<w:tr>" + "".join(f"<w:tc><w:p><w:r><w:t>{c}</w:t></w:r></w:p></w:tc>" for c in row) + "</w:tr>"
            for row in table
        )
        body += f"<w:tbl>{rows}</w:tbl>"
    xml = f"<?xml version='1.0' encoding='UTF-8'?><w:document xmlns:w='{W_NS}'><w:body>{body}</w:body></w:document>"
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("word/document.xml", xml)
    return path


@pytest.fixture
def qiso():
    return load_case("qiso")


@pytest.fixture(autouse=True)
def offline_by_default():
    """Tests never call a real model unless they install a stub."""
    llm.set_client(None)
    yield
    llm.set_client(None)
