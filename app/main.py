import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from . import llm, sandbox
from .battle import battles, create_battle, run_battle
from .browser import pool
from .config import get_settings
from .regulations import PATTERNS
from .scanner import scan
from .security import UnsafeURL, check_public_url, limiter

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await pool.start()
    yield
    await pool.stop()


app = FastAPI(title="CoercionGuard API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)
_background: set[asyncio.Task] = set()


def _rate_limit(request: Request) -> None:
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()
    if not limiter.allow(ip):
        raise HTTPException(429, "Too many requests, slow down")


class ScanRequest(BaseModel):
    url: str | None = None
    sandbox_id: str | None = None

    @model_validator(mode="after")
    def exactly_one(self):
        if bool(self.url) == bool(self.sandbox_id):
            raise ValueError("Provide exactly one of url or sandbox_id")
        return self


class BattleRequest(BaseModel):
    sandbox_id: str
    goal: str | None = Field(default=None, max_length=400)


@app.get("/api/health")
async def health():
    s = get_settings()
    return {"ok": True, "agent_mode": "llm" if s.agent_mode == "llm" and llm.enabled() else "heuristic",
            "queued": pool.queued, "patterns": len(PATTERNS), "sandboxes": len(sandbox.SANDBOXES)}


@app.get("/api/patterns")
async def patterns():
    return PATTERNS


@app.get("/api/sandboxes")
async def sandboxes():
    return sandbox.list_sandboxes()


@app.post("/api/scan")
async def scan_endpoint(body: ScanRequest, request: Request):
    _rate_limit(request)
    if body.sandbox_id:
        if body.sandbox_id not in sandbox.SANDBOXES:
            raise HTTPException(404, "Unknown sandbox")
        return await scan(sandbox_id=body.sandbox_id)
    try:
        url = await check_public_url(body.url)
    except UnsafeURL as e:
        raise HTTPException(400, str(e))
    return await scan(url=url)


@app.post("/api/battles", status_code=202)
async def start_battle(body: BattleRequest, request: Request):
    _rate_limit(request)
    if body.sandbox_id not in sandbox.SANDBOXES:
        raise HTTPException(404, "Unknown sandbox")
    b = create_battle(body.sandbox_id, body.goal)
    task = asyncio.create_task(run_battle(b))
    _background.add(task)
    task.add_done_callback(_background.discard)
    return {**b.summary(), "ws": f"/ws/battles/{b.id}"}


@app.get("/api/battles/{battle_id}")
async def get_battle(battle_id: str, include_events: bool = False):
    b = battles.get(battle_id)
    if not b:
        raise HTTPException(404, "Unknown battle")
    out = b.summary()
    if include_events:
        out["events"] = b.events
    return out


@app.websocket("/ws/battles/{battle_id}")
async def battle_ws(ws: WebSocket, battle_id: str):
    b = battles.get(battle_id)
    await ws.accept()
    if not b:
        await ws.send_json({"type": "error", "message": "Unknown battle"})
        await ws.close()
        return
    q = b.subscribe()
    try:
        while True:
            event = await q.get()
            await ws.send_json(event)
            if event["type"] == "battle_finished":
                break
    except WebSocketDisconnect:
        pass
    finally:
        b.unsubscribe(q)
    await ws.close()


# Sandbox pages are also served directly so the frontend can iframe the raw trap.
@app.get("/sandbox/{sandbox_id}/", response_class=HTMLResponse)
async def sandbox_page(sandbox_id: str):
    try:
        return sandbox.page_html(sandbox_id)
    except KeyError:
        raise HTTPException(404, "Unknown sandbox")


@app.api_route("/sandbox/{sandbox_id}/submit", methods=["GET", "POST"], response_class=HTMLResponse)
async def sandbox_submit(sandbox_id: str, request: Request):
    if sandbox_id not in sandbox.SANDBOXES:
        raise HTTPException(404, "Unknown sandbox")
    form = sandbox.parse_form(await request.body(), request.url.query)
    return sandbox.receipt_html(sandbox.checkout(sandbox_id, form))


# Serve the frontend from the same origin; mounted last so API routes win.
FRONTEND_DIR = Path(__file__).parent.parent / "frontrend" / "dist"
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
