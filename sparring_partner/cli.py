"""Command-line entry point.

    sparring-partner ingest [--case qiso]     build corpora from cases_raw/
    sparring-partner serve [--port 8000]      run the API and web app
    sparring-partner check                    validate built corpora
"""

from __future__ import annotations

import argparse
import sys

from . import config


def _ingest(args: argparse.Namespace) -> int:
    from .ingest import ingest_all

    try:
        written = ingest_all(only=args.case or None)
    except FileNotFoundError as err:
        print(f"error: {err}\nPut the raw case files under {config.RAW_DIR} (see README).", file=sys.stderr)
        return 1
    for path in written:
        print(f"wrote {path.relative_to(config.REPO_ROOT) if path.is_relative_to(config.REPO_ROOT) else path}")
    return 0


def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .llm import get_client

    mode = "Claude (" + config.DEFAULT_MODEL + ")" if get_client() else "offline (retrieval only)"
    print(f"Sparring Partner on http://{args.host}:{args.port}  ·  model: {mode}")
    uvicorn.run("sparring_partner.api:app", host=args.host, port=args.port, reload=args.reload)
    return 0


def _check(_: argparse.Namespace) -> int:
    from .corpus import list_cases, load_case

    cases = list_cases()
    if not cases:
        print(f"No built cases in {config.CORPUS_DIR}. Run `sparring-partner ingest`.", file=sys.stderr)
        return 1
    for entry in cases:
        case = load_case(entry["id"])
        for role in case.roles:
            docs = case.visible_documents(role.id)
            print(f"{case.id:>14} · {role.id:<16} {len(docs):>3} documents")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sparring-partner")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("ingest", help="build case corpora from raw files")
    p.add_argument("--case", action="append", help="only this case id (repeatable)")
    p.set_defaults(func=_ingest)

    p = sub.add_parser("serve", help="run the web app")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true")
    p.set_defaults(func=_serve)

    p = sub.add_parser("check", help="validate built corpora")
    p.set_defaults(func=_check)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
