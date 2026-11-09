PY ?= .venv/bin/python

.PHONY: install ingest serve demo test check clean

install:            ## create .venv and install with all extras
	python3 -m venv .venv
	$(PY) -m pip install -U pip
	$(PY) -m pip install -e ".[all]"

ingest:             ## rebuild web/data/cases from cases_raw/
	$(PY) -m sparring_partner.cli ingest

serve:              ## run the app on http://127.0.0.1:8000
	$(PY) -m sparring_partner.cli serve --reload

demo:               ## static scripted demo, no Python dependencies
	python3 -m http.server 8000 --directory web

test:               ## run the test suite
	$(PY) -m pytest -q

check:              ## validate built corpora
	$(PY) -m sparring_partner.cli check

clean:
	rm -rf .pytest_cache build dist *.egg-info
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
