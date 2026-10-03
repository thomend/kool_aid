# hackamrhein_challenge
Repo for Kool Aid

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

If you want to run fast API: 
```
fastapi run api/app.py --host 0.0.0.0 --port 8050
```

Open in host browser:
```
$BROWSER http://localhost:8050
```

Default pages:
- Root: http://localhost:8050/
- OpenAPI UI: http://localhost:8050/docs



# Datasets

Humanbioklimatische Situation, Kanton Basel-Stadt

Source: Geodaten Kanton Basel-Stadt
License: CC BY 4.0
https://creativecommons.org/licenses/by/4.0/

The original dataset is distributed by the Kanton Basel-Stadt.