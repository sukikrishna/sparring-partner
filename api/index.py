"""Vercel entry point: the FastAPI app as a Python serverless function.

Vercel serves the browser app in ``web/`` as static files and routes
``/api/*`` here (see ``vercel.json``).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sparring_partner.api import app  # noqa: E402,F401
