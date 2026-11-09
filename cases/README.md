# Cases

Each folder holds a `manifest.toml` describing one negotiation simulation:
its roles, the documents each role may see, and optional starter notes. The
raw source files live in `cases_raw/` (not tracked); `sparring-partner ingest`
turns them into `web/data/cases/<id>.json`.

| Case | Roles | Documents |
|---|---|---|
| `qiso` | Mayor of Qiso, Border Authority officer | 31 |
| `beta-hospital` | HfA delegation, tribal council | 29 |
| `alpha-camp` | FWB delegate, Camp Commander | 21 |

All places, organisations and people in the cases are fictional.

The case texts are teaching material and are not covered by the repository's
MIT License; reuse them only with the case authors' permission.

See [../docs/adding-a-case.md](../docs/adding-a-case.md) to add one.
