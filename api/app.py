from fastapi import FastAPI

import frontend, routes

app = FastAPI(title="Mock FastAPI App - Hackaton")

app.include_router(routes.router)
app.include_router(frontend.router)
