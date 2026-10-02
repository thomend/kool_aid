# hackamrhein_challenge
Repo for Hackaton hackamrhein

# How to update dependencies
uv pip compile requirements.in -o requirements.txt

# then run
uv pip sync requirements.txt --system

Minimal mock FastAPI app.

Run locally:
```bash
# start dev server (bind to all interfaces)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8050
```

Open in host browser:
```
$BROWSER http://localhost:8050
```

Default pages:
- Root: http://localhost:8050/
- OpenAPI UI: http://localhost:8050/docs