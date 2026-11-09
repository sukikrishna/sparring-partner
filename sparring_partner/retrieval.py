"""Lexical retrieval over case paragraphs (Okapi BM25, no external services).

Case corpora are small (tens of documents, hundreds of paragraphs), so an
in-memory index rebuilt per case is fast and dependency-free. Retrieval is
always scoped to the documents a role may see.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass

from .schemas import Case, Document

_TOKEN = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")

# Small English stopword list; keeps numbers and domain words.
STOPWORDS = frozenset(
    """a an and are as at be been but by can could did do does for from had has have he her his
    how i if in into is it its me my no not of on or our she so than that the their them then
    there these they this those to was we were what when where which who why will with would
    you your about after all also am any because before being both each few further here more
    most other out over own same should some such through too under until up very just""".split()
)


def tokenize(text: str) -> list[str]:
    tokens = _TOKEN.findall(text.lower().replace("’", "'"))
    return [_stem(t) for t in tokens if t not in STOPWORDS]


def _stem(token: str) -> str:
    """A deliberately light stemmer: plural and common verb suffixes only."""
    for suffix, min_len in (("ies", 5), ("ing", 6), ("ed", 5), ("es", 5), ("s", 4)):
        if token.endswith(suffix) and len(token) >= min_len:
            if suffix == "ies":
                return token[:-3] + "y"
            return token[: -len(suffix)]
    return token


@dataclass(frozen=True)
class Passage:
    doc_id: str
    doc_title: str
    paragraph: int  # 1-based
    text: str
    score: float = 0.0


class BM25Index:
    def __init__(self, passages: list[Passage], k1: float = 1.4, b: float = 0.75) -> None:
        self.passages = passages
        self.k1, self.b = k1, b
        self._tfs = [Counter(tokenize(p.text + " " + p.doc_title)) for p in passages]
        self._lens = [sum(tf.values()) for tf in self._tfs]
        self._avg = (sum(self._lens) / len(self._lens)) if self._lens else 0.0
        df: Counter[str] = Counter()
        for tf in self._tfs:
            df.update(tf.keys())
        n = len(passages)
        self._idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    @classmethod
    def from_documents(cls, documents: list[Document]) -> "BM25Index":
        passages = [
            Passage(doc_id=d.id, doc_title=d.title, paragraph=i, text=p)
            for d in documents
            for i, p in enumerate(d.paragraphs, start=1)
        ]
        return cls(passages)

    def search(self, query: str, k: int = 8, min_chars: int = 25) -> list[Passage]:
        q = set(tokenize(query))
        if not q:
            return []
        scored: list[Passage] = []
        for passage, tf, length in zip(self.passages, self._tfs, self._lens):
            if len(passage.text) < min_chars:
                continue
            score = 0.0
            for term in q:
                f = tf.get(term)
                if not f:
                    continue
                norm = f + self.k1 * (1 - self.b + self.b * length / (self._avg or 1))
                score += self._idf[term] * f * (self.k1 + 1) / norm
            if score > 0:
                scored.append(
                    Passage(passage.doc_id, passage.doc_title, passage.paragraph, passage.text, score)
                )
        scored.sort(key=lambda p: p.score, reverse=True)
        return scored[:k]


_INDEX_CACHE: dict[tuple[str, str], BM25Index] = {}


def index_for(case: Case, role_id: str) -> BM25Index:
    key = (case.id, role_id)
    if key not in _INDEX_CACHE:
        _INDEX_CACHE[key] = BM25Index.from_documents(case.visible_documents(role_id))
    return _INDEX_CACHE[key]


def clear_cache() -> None:
    _INDEX_CACHE.clear()
