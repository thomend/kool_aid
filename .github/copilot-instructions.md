# Copilot instructions for this repo

## Data pipeline
- Every new dataset gets its own script under `scripts/` showing exactly how it was
  downloaded/fetched and loaded into DuckDB (see `scripts/fetch_pedestrian_paths.py`
  as the reference pattern: fetch -> transform -> write to `data/pedestrian_paths.duckdb`).
- New data is always added to DuckDB (`data/pedestrian_paths.duckdb`), not left as
  loose files, in-memory objects, or committed as raw downloads.
- Never perform schema changes or destructive operations (`DROP TABLE`,
  `ALTER TABLE`, `DELETE`, `CREATE OR REPLACE TABLE` over an existing table, etc.)
  without first confirming with a human. Additive inserts into existing, unchanged
  schemas are fine without confirmation.

## FastAPI app (`api/`)
- Keep it simple: no high abstraction layers, no service/repository patterns, no
  dependency-injection frameworks. Plain functions and `APIRouter`s are enough.
- `api/app.py` stays lean: create the `FastAPI` app and `include_router(...)` the
  routers. No route logic or HTML lives here.
- Route handlers go in `api/routes.py` (or a similarly named module per concern).
- The static/minimal frontend lives in `api/static/` and is served via
  `FileResponse`; don't inline HTML/JS as Python string literals in route files.
- `api/db.py` holds the one DuckDB connection helper; routes call it directly.
- Imports between files in `api/` are plain bare module imports
  (e.g. `import frontend, routes`, `from db import get_connection`), not
  relative (`from . import ...`) or absolute-package (`from api import ...`).

## Dependencies
- Never `pip install` directly. Add/change packages only in `requirements.in`.
- Compile: `uv pip compile requirements.in -o requirements.txt`
- Then sync the environment: `uv pip sync requirements.txt --system`
- See `README.md` for the same steps.
