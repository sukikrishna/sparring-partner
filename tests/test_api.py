import pytest
from fastapi.testclient import TestClient

from sparring_partner import config, llm
from sparring_partner.api import app
from sparring_partner.schemas import Gap, GapSet, RecheckResult

client = TestClient(app)


def test_health_offline():
    body = client.get("/api/health").json()
    assert body["status"] == "ok" and body["llm"] is False


def test_cases_and_role_view():
    ids = [c["id"] for c in client.get("/api/cases").json()["cases"]]
    assert "qiso" in ids
    view = client.get("/api/cases/qiso", params={"role": "mayor"}).json()
    doc_ids = {d["id"] for d in view["documents"]}
    assert "finance-memo" in doc_ids and "hq-instructions" not in doc_ids
    assert view["role"]["starter_notes"]
    assert "source" not in view["documents"][0]


def test_unknown_case_and_role():
    assert client.get("/api/cases/nope", params={"role": "mayor"}).status_code == 404
    assert client.get("/api/cases/qiso", params={"role": "nobody"}).status_code == 404
    assert client.get("/api/cases/..%2Fsecrets", params={"role": "x"}).status_code == 404


def test_raw_corpus_files_are_not_served():
    assert client.get("/data/cases/qiso.json").status_code == 404
    assert client.get("/data/cases/index.json").status_code == 200


def test_document_chat_respects_barrier():
    r = client.post(
        "/api/chat/document",
        json={"case_id": "qiso", "role_id": "mayor", "doc_id": "hq-instructions", "question": "x"},
    )
    assert r.status_code == 404


def test_document_chat_offline():
    r = client.post(
        "/api/chat/document",
        json={"case_id": "qiso", "role_id": "mayor", "doc_id": "finance-memo", "question": "when is compensation paid"},
    )
    assert r.status_code == 200
    assert 27 in r.json()["cited_paragraphs"]


def test_gaps_offline_is_503():
    r = client.post("/api/gaps", json={"case_id": "qiso", "role_id": "mayor", "notes": "some notes"})
    assert r.status_code == 503
    assert "language model" in r.json()["detail"]


def test_gaps_with_stub():
    notes = "police can handle gathering people at the stadium."
    llm.set_client(
        llm.StubLLMClient(
            {
                GapSet: lambda c: GapSet(
                    gaps=[
                        Gap(
                            quote=notes,
                            title="Police capacity",
                            question="How many officers?",
                            assumption="Police can do it",
                            lens="Resources",
                            doc_ids=["police-memo"],
                            severity="high",
                        )
                    ]
                )
            }
        )
    )
    r = client.post("/api/gaps", json={"case_id": "qiso", "role_id": "mayor", "notes": notes})
    assert r.status_code == 200
    assert r.json()[0]["doc_ids"] == ["police-memo"]


def test_recheck_offline_similarity():
    gap = {"quote": "police can handle gathering people at the stadium"}
    same = client.post("/api/recheck", json={"case_id": "qiso", "role_id": "mayor", "gap": gap, "revised_passage": gap["quote"]})
    assert same.json()["resolved"] is False
    new = client.post(
        "/api/recheck",
        json={"case_id": "qiso", "role_id": "mayor", "gap": gap, "revised_passage": "ask the chief what is feasible first"},
    )
    assert new.json()["resolved"] is True


def test_recheck_uses_model_when_available():
    llm.set_client(llm.StubLLMClient({RecheckResult: lambda c: RecheckResult(resolved=False, explanation="still assumes")}))
    r = client.post(
        "/api/recheck",
        json={"case_id": "qiso", "role_id": "mayor", "gap": {"quote": "a b c"}, "revised_passage": "x y z"},
    )
    assert r.json() == {"resolved": False, "explanation": "still assumes"}


def test_structure_offline():
    r = client.post("/api/structure", json={"case_id": "qiso", "role_id": "mayor", "notes": "what I want: keep calm."})
    assert r.status_code == 200
    assert r.json()["objective"]


def test_session_logging_disabled_by_default():
    assert client.post("/api/sessions", json={"session_id": "s"}).status_code == 403


def test_session_logging_enabled(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ACCEPT_SESSION_LOGS", True)
    monkeypatch.setattr(config, "SESSION_LOG_DIR", tmp_path)
    r = client.post("/api/sessions", json={"session_id": "abc/../x", "events": []})
    assert r.status_code == 200
    saved = list(tmp_path.iterdir())
    assert len(saved) == 1 and saved[0].name.endswith("-abcx.json")


@pytest.mark.parametrize("path", ["/", "/js/main.js", "/css/app.css", "/data/demo/qiso-mayor.json"])
def test_static_files(path):
    assert client.get(path).status_code == 200
