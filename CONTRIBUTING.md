# Contributing

## Setup

```bash
make install        # .venv with all extras
make test
make serve          # http://127.0.0.1:8000
```

## Guidelines

- Keep the human and AI spaces separate. Nothing the model produces should be
  written into the Human-Only editor.
- Every AI claim shown to users needs a source (document + paragraph) or must
  say it has none. New agents should validate citations server-side.
- Respect the information barrier: build prompts from
  `Case.visible_documents(role_id)` only, and add a test with a positive
  control when you add a new prompt.
- Agents must work offline (return a retrieval-only or heuristic answer when
  `llm is None`) so the app and tests run without credentials.
- The frontend has no build step. Use plain ES modules and keep dependencies at
  zero.
- If you change the starter notes or corpus, run `pytest`: the scripted demo is
  validated against both.
