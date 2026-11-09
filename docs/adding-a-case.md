# Adding a case

A case is a folder of source files plus a manifest that says who may see what.

## 1. Put the raw files under `cases_raw/`

```
cases_raw/
  Cases/
    My Case/
      Party A/  memo.docx  letter.docx
      Party B/  orders.docx
      Shared/   news.pdf
```

`cases_raw/` is gitignored. Supported formats: `.docx` (paragraphs and tables),
text `.pdf` (needs `pip install "sparring-partner[pdf]"`), `.txt`/`.md`.

## 2. Write `cases/<case-id>/manifest.toml`

```toml
id = "my-case"
title = "Short title"
summary = "Two or three sentences shown to every role."
source_root = "Cases/My Case"   # relative to cases_raw/

[[roles]]
id = "party-a"
name = "Party A"
counterpart = "Party B"
brief = "Who the user is in this role and what they are preparing for."
starter_notes_file = "party_a_notes.txt"   # optional, next to the manifest

[[roles]]
id = "party-b"
name = "Party B"
brief = "..."

[[documents]]
id = "memo"                      # stable id, used in citations
title = "Budget memo"
kind = "Memo"                    # groups documents in the library
visible_to = ["party-a"]         # the information barrier
source = "Party A/memo.docx"

[[documents]]
id = "news"
title = "Local news report"
kind = "News"
visible_to = ["party-a", "party-b"]
source = "Shared/news.pdf"
drop_leading = 1                 # drop header paragraphs
fixups = [["typo", "fixed"]]     # literal replacements
```

A single packet with sections headed `1. Source: <title>`, `2. Source: ...` can
be split into one document per section with `split = "numbered-sources"`.

## 3. Build and check

```bash
sparring-partner ingest --case my-case
sparring-partner check
pytest -q
```

`ingest` fails loudly on missing files, unknown roles, duplicate ids and empty
documents. The tests check that every role has private documents and that the
barrier holds.

## 4. Optional: a scripted demo

A scripted demo lets people try the role without a model. Add
`web/data/demo/<case-id>-<role-id>.json` (see `qiso-mayor.json` for the format:
gaps with exact quotes from the starter notes, prepared answers per document
with paragraph citations, case-wide answers, and a structured view), then list
it in `web/data/demo/index.json`. `tests/test_demo_script.py` validates every
quote and citation against the corpus.
