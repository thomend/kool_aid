from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from .graph import router as graph_router
from .graph import store as graph_store
from .layout import router as layout_router
from .layout import store as layout_store
from .routing import router as routing_router

WEB_DIST = Path(__file__).parents[1] / "web" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    graph_store.load()
    layout_store.load()
    yield


app = FastAPI(title="Kool Aid – Walkable Basel", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.include_router(graph_router)
app.include_router(layout_router)
app.include_router(routing_router)

# Serve the built frontend (npm run build in web/) if it exists
if WEB_DIST.exists():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
