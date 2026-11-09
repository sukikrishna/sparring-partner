from sparring_partner.retrieval import BM25Index, index_for, tokenize


def test_tokenize_stems_and_drops_stopwords():
    assert tokenize("The officers were gathering the families") == ["officer", "gather", "family"]


def test_search_ranks_relevant_paragraph_first(qiso):
    hits = index_for(qiso, "mayor").search("compensation paid after 90 days verified register", k=3)
    assert hits[0].doc_id in {"finance-memo", "ba-letter", "protocols"}
    assert all(h.score > 0 for h in hits)


def test_search_is_scoped_to_role(qiso):
    # Text only in the officer's restricted instructions must not be retrievable by the mayor.
    query = "Aichi faction one in five military-age men"
    mayor_hits = index_for(qiso, "mayor").search(query, k=20)
    officer_hits = index_for(qiso, "border-officer").search(query, k=20)
    assert all(h.doc_id != "hq-instructions" for h in mayor_hits)
    assert any(h.doc_id == "hq-instructions" for h in officer_hits)


def test_empty_query():
    assert BM25Index([]).search("") == []
