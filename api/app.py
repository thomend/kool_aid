import frontend
import routes
from fastapi import FastAPI

app = FastAPI(title="Mock FastAPI App - Hackaton")

app.include_router(routes.router)
app.include_router(frontend.router)
