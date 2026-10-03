from fastapi import FastAPI
from fastapi.responses import HTMLResponse

app = FastAPI(title="Mock FastAPI App - Hackaton")

@app.get("/", response_class=HTMLResponse)
async def root():
    return "<h1>Mock FastAPI App</h1><p>Visit <a href='/docs'>/docs</a> UI.</p>"