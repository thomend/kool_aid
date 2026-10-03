"""Serves the minimal static frontend page."""

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

router = APIRouter()

STATIC_DIR = Path(__file__).resolve().parent / "static"


@router.get("/")
async def root():
    return FileResponse(STATIC_DIR / "index.html")
