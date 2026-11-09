"""Build case corpora from raw .docx / .pdf files, driven by a manifest.

Each case lives in ``cases/<case_id>/manifest.toml``. The manifest names every
document explicitly (title, genre, which roles may see it, source file), so
the information barrier between roles is reviewable in one place rather than
inferred from folder names.

    id = "qiso"
    title = "..."
    summary = "..."
    source_root = "Cases/Final"          # relative to the raw dir

    [[roles]]
    id = "mayor"
    name = "Mayor of Qiso"
    counterpart = "Border Authority officer"
    brief = "..."
    starter_notes_file = "mayor_notes.txt"   # optional, relative to the manifest

    [[documents]]
    id = "finance-memo"
    title = "Fiscal implications of the stadium request"
    kind = "Memo"
    visible_to = ["mayor"]
    source = "Mayor/Message from Qiso Finance.docx"
    drop_leading = 0                     # optional: drop N leading paragraphs
    split = "numbered-sources"           # optional: one doc per "N. Source:" heading
    fixups = [["old", "new"]]            # optional: literal text replacements

Run ``sparring-partner ingest`` to (re)build ``web/data/cases/<id>.json``.
"""

from __future__ import annotations

import json
import re
import tomllib
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from . import config
from .schemas import Case, Document, Role

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# =============================================================================
# Extraction
# =============================================================================


def _clean(text: str) -> str:
    text = text.replace(" ", " ").replace("​", "")
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def _docx_paragraph_text(p: ET.Element) -> str:
    parts: list[str] = []
    for node in p.iter():
        if node.tag == _W + "t" and node.text:
            parts.append(node.text)
        elif node.tag in (_W + "tab",):
            parts.append(" ")
        elif node.tag in (_W + "br", _W + "cr"):
            parts.append("\n")
    return "".join(parts)


def extract_docx(path: Path) -> list[str]:
    """Paragraphs of a .docx in reading order. Table rows become 'a | b | c'."""
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    body = root.find(_W + "body")
    if body is None:
        return []
    out: list[str] = []
    for child in body:
        if child.tag == _W + "p":
            for line in _docx_paragraph_text(child).split("\n"):
                if _clean(line):
                    out.append(_clean(line))
        elif child.tag == _W + "tbl":
            for row in child.iter(_W + "tr"):
                cells = []
                for cell in row.iter(_W + "tc"):
                    cell_text = " ".join(
                        _clean(_docx_paragraph_text(p)) for p in cell.iter(_W + "p")
                    )
                    cells.append(_clean(cell_text))
                if any(cells):
                    out.append(" | ".join(cells))
    return out


def extract_pdf(path: Path) -> list[str]:
    """Paragraphs of a text PDF: blank-line separated blocks, hard wraps joined."""
    try:
        import pymupdf  # type: ignore
    except ImportError as err:  # pragma: no cover - optional dependency
        raise RuntimeError(
            f"{path.name}: PDF ingestion needs PyMuPDF (pip install 'sparring-partner[pdf]')"
        ) from err
    with pymupdf.open(path) as doc:
        text = "\n".join(page.get_text() for page in doc)
    paragraphs: list[str] = []
    for block in re.split(r"\n\s*\n", text):
        joined = _clean(" ".join(line.strip() for line in block.splitlines()))
        if joined:
            paragraphs.append(joined)
    return paragraphs


def extract(path: Path) -> list[str]:
    suffix = path.suffix.lower()
    if suffix == ".docx":
        return extract_docx(path)
    if suffix == ".pdf":
        return extract_pdf(path)
    if suffix in (".txt", ".md"):
        return [_clean(p) for p in re.split(r"\n\s*\n", path.read_text()) if _clean(p)]
    raise ValueError(f"unsupported file type: {path}")


# =============================================================================
# Splitting
# =============================================================================

_SOURCE_HEADING = re.compile(r"^(\d{1,2})\.\s*Source:\s*(.+)$")


def split_numbered_sources(paragraphs: list[str]) -> list[tuple[str, list[str]]]:
    """Split a case packet into (title, paragraphs) at '<n>. Source: <title>' headings.

    Paragraphs before the first heading become a 'Case background' section.
    """
    sections: list[tuple[str, list[str]]] = []
    title, buf = "Case background", []
    for para in paragraphs:
        m = _SOURCE_HEADING.match(para)
        if m:
            if buf:
                sections.append((title, buf))
            title, buf = m.group(2).strip().rstrip("."), []
        else:
            buf.append(para)
    if buf:
        sections.append((title, buf))
    return sections


# =============================================================================
# Building
# =============================================================================


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:48]


def build_case(manifest_path: Path, raw_dir: Path | None = None) -> Case:
    raw_dir = raw_dir or config.RAW_DIR
    manifest = tomllib.loads(manifest_path.read_text())
    root = raw_dir / manifest.get("source_root", "")

    roles: list[Role] = []
    for r in manifest["roles"]:
        notes = ""
        if r.get("starter_notes_file"):
            notes = (manifest_path.parent / r["starter_notes_file"]).read_text().strip()
        roles.append(
            Role(
                id=r["id"],
                name=r["name"],
                brief=r["brief"].strip(),
                counterpart=r.get("counterpart", ""),
                starter_notes=notes,
            )
        )
    role_ids = {r.id for r in roles}

    documents: list[Document] = []
    for d in manifest["documents"]:
        unknown = set(d["visible_to"]) - role_ids
        if unknown:
            raise ValueError(f"{d['id']}: visible_to names unknown roles {sorted(unknown)}")
        src = root / d["source"]
        if not src.exists():
            raise FileNotFoundError(f"{d['id']}: missing raw file {src}")
        paragraphs = extract(src)
        for old, new in d.get("fixups", []):
            paragraphs = [p.replace(old, new) for p in paragraphs]
        paragraphs = [p.strip() for p in paragraphs if p.strip()]
        paragraphs = paragraphs[d.get("drop_leading", 0):]
        rel = str(src.relative_to(raw_dir))

        if d.get("split") == "numbered-sources":
            for i, (title, paras) in enumerate(split_numbered_sources(paragraphs)):
                documents.append(
                    Document(
                        id=f"{d['id']}-{i:02d}",
                        title=title,
                        kind=d.get("kind", "Document") if i else "Background",
                        visible_to=d["visible_to"],
                        paragraphs=paras,
                        source=rel,
                    )
                )
        else:
            documents.append(
                Document(
                    id=d["id"],
                    title=d["title"],
                    kind=d.get("kind", "Document"),
                    visible_to=d["visible_to"],
                    paragraphs=paragraphs,
                    source=rel,
                )
            )

    ids = [doc.id for doc in documents]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise ValueError(f"duplicate document ids: {sorted(dupes)}")
    empty = [doc.id for doc in documents if not doc.paragraphs]
    if empty:
        raise ValueError(f"documents with no text: {empty}")

    return Case(
        id=manifest["id"],
        title=manifest["title"],
        summary=manifest["summary"].strip(),
        roles=roles,
        documents=documents,
    )


def write_case(case: Case, out_dir: Path | None = None) -> Path:
    out_dir = out_dir or config.CORPUS_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{case.id}.json"
    path.write_text(json.dumps(case.model_dump(), ensure_ascii=False, indent=1) + "\n")
    return path


def write_index(out_dir: Path | None = None) -> Path:
    """index.json lists every built case (read by the static frontend)."""
    out_dir = out_dir or config.CORPUS_DIR
    entries = []
    for path in sorted(out_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        case = Case.model_validate_json(path.read_text())
        entries.append(
            {
                "id": case.id,
                "title": case.title,
                "summary": case.summary,
                "roles": [{"id": r.id, "name": r.name} for r in case.roles],
                "documents": len(case.documents),
            }
        )
    index = out_dir / "index.json"
    index.write_text(json.dumps({"cases": entries}, ensure_ascii=False, indent=1) + "\n")
    return index


def ingest_all(
    manifest_dir: Path | None = None,
    raw_dir: Path | None = None,
    out_dir: Path | None = None,
    only: list[str] | None = None,
) -> list[Path]:
    manifest_dir = manifest_dir or config.MANIFEST_DIR
    written = []
    for manifest in sorted(manifest_dir.glob("*/manifest.toml")):
        if only and manifest.parent.name not in only:
            continue
        case = build_case(manifest, raw_dir)
        written.append(write_case(case, out_dir))
    write_index(out_dir)
    return written
