import asyncio
import logging
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Header, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from . import analyst, archive, llm, reminders, sandbox, uploads
from .battle import battles, create_battle, run_battle
from .browser import pool
from .capture import CaptureError, capture_page
from .config import get_settings
from .guard import router as guard_router
from .regulations import PATTERNS
from .scanner import scan
from .reviews import store
from .security import UnsafeURL, check_public_url, limiter

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await pool.start()

    async def purge_loop():
        while True:
            await asyncio.sleep(60)
            store.purge()  # captures expire after REVIEW_TTL_SECONDS

    purger = asyncio.create_task(purge_loop())
    yield
    purger.cancel()
    await pool.stop()


app = FastAPI(title="CoercionGuard API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)
_background: set[asyncio.Task] = set()


@app.middleware("http")
async def no_store_reviews(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/reviews"):
        response.headers["Cache-Control"] = "no-store"  # reviews are private to whoever holds the ID
    return response


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
    sandbox_id: str | None = None
    url: str | None = Field(default=None, max_length=2048)  # a live page instead of a bundled one
    page_id: str | None = Field(default=None, max_length=64)  # a page the user saved and uploaded
    goal: str | None = Field(default=None, max_length=400)

    @model_validator(mode="after")
    def one_target(self):
        if sum(map(bool, (self.url, self.sandbox_id, self.page_id))) != 1:
            raise ValueError("Provide exactly one of sandbox_id, url or page_id")
        if (self.url or self.page_id) and len((self.goal or "").strip()) < 3:
            raise ValueError("Say what the agent should avoid on this page")
        return self


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
    url = None
    if body.page_id:
        saved = uploads.get(body.page_id)
        if not saved:
            raise HTTPException(404, "That uploaded page has expired. Upload it again.")
        url = saved.url
    elif body.url:
        try:
            url = await check_public_url(body.url.strip())
        except UnsafeURL as e:
            raise HTTPException(400, str(e))
        if not url.startswith("https://") and not get_settings().allow_private_urls:
            raise HTTPException(400, "Use an https:// address.")
    elif body.sandbox_id not in sandbox.SANDBOXES:
        raise HTTPException(404, "Unknown sandbox")
    b = create_battle(body.sandbox_id, body.goal, url=url)
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


# ---------- Live page reviews ----------

class ReviewRequest(BaseModel):
    url: str | None = Field(default=None, max_length=2048)
    page_id: str | None = Field(default=None, max_length=64)
    goal: str = Field(min_length=3, max_length=500)

    @model_validator(mode="after")
    def one_target(self):
        if bool(self.url) == bool(self.page_id):
            raise ValueError("Provide exactly one of url or page_id")
        return self


class SelectionsRequest(BaseModel):
    selections: dict[str, bool | str] = Field(default_factory=dict)


class CheckRequest(BaseModel):
    selections: dict[str, bool | str] | None = None


class ReminderRequest(BaseModel):
    trial_end_date: str
    timezone: str
    days_before: int = 2


def _review(review_id: str):
    r = store.get(review_id)
    if not r:
        raise HTTPException(404, "This review doesn't exist or has expired. Reviews last one hour.")
    return r


def _with_state(r) -> dict:
    out = r.public(screenshot=False)
    if r.assessment:
        out["assessment_stale"] = r.assessment["checked_selections"] != r.selections
    return out


@app.post("/api/reviews", status_code=201)
async def create_review(body: ReviewRequest, request: Request):
    _rate_limit(request)
    if body.page_id:
        saved = uploads.get(body.page_id)
        if not saved:
            raise HTTPException(422, {"status": "rejected", "message": "That uploaded page has expired.", "hint": "Upload it again."})
        target, label = saved.url, saved.name
    else:
        target = label = body.url.strip()
    try:
        cap = await capture_page(target)
    except CaptureError as e:
        raise HTTPException(422, {"status": e.status, "message": str(e),
                                  "hint": "Try the site's public pricing, terms or cancellation page."})
    if cap["status"] == "login_required":
        raise HTTPException(422, {"status": "login_required", "message": cap["notes"][0],
                                  "hint": "Try the site's public pricing or terms page instead."})
    r = store.create(label, body.goal.strip(), cap)
    return r.public()


@app.post("/api/pages", status_code=201)
async def upload_page(request: Request, file: UploadFile = File(...)):
    """A page the user saved from their own browser, for sites that block us or need sign-in."""
    _rate_limit(request)
    raw = await file.read(uploads.MAX_BYTES + 1)
    try:
        page = uploads.add(file.filename or "saved page", raw)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"page_id": page.id, "name": page.name, "title": page.title}


@app.get("/api/archive")
async def archived_copy(url: str, request: Request):
    _rate_limit(request)
    try:
        url = await check_public_url(url.strip())
    except UnsafeURL as e:
        raise HTTPException(400, str(e))
    try:
        found = await archive.latest_copy(url)
    except Exception:
        raise HTTPException(502, "The Internet Archive didn't answer. Try again, or upload a saved copy.")
    if not found:
        raise HTTPException(404, "The Internet Archive has no copy of this page. Upload a saved copy instead.")
    return found


@app.get("/api/reviews/{review_id}")
async def get_review(review_id: str, screenshot: bool = True):
    r = _review(review_id)
    out = r.public(screenshot=screenshot)
    if r.assessment:
        out["assessment_stale"] = r.assessment["checked_selections"] != r.selections
    return out


@app.patch("/api/reviews/{review_id}/selections")
async def update_selections(review_id: str, body: SelectionsRequest):
    r = _review(review_id)
    try:
        r.set_selections(body.selections)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return _with_state(r)


@app.post("/api/reviews/{review_id}/reset")
async def reset_review(review_id: str):
    r = _review(review_id)
    r.reset()
    return _with_state(r)


@app.post("/api/reviews/{review_id}/check")
async def check_review(review_id: str, body: CheckRequest, request: Request):
    _rate_limit(request)
    r = _review(review_id)
    if body.selections:
        try:
            r.set_selections(body.selections)
        except ValueError as e:
            raise HTTPException(422, str(e))
    r.assessment = await analyst.assess(r)
    return _with_state(r)


@app.post("/api/reviews/{review_id}/reminder/preview")
async def preview_reminder(review_id: str, body: ReminderRequest):
    r = _review(review_id)
    try:
        event = reminders.build_event(r, body.trial_end_date, body.timezone, body.days_before)
    except reminders.ReminderError as e:
        raise HTTPException(422, str(e))
    return {"event": event, "ics_url": f"/api/reviews/{review_id}/reminder.ics?trial_end_date={body.trial_end_date}"
            f"&timezone={body.timezone}&days_before={body.days_before}"}


@app.get("/api/reviews/{review_id}/reminder.ics")
async def reminder_ics(review_id: str, trial_end_date: str, timezone: str, days_before: int = 2):
    r = _review(review_id)
    try:
        event = reminders.build_event(r, trial_end_date, timezone, days_before)
    except reminders.ReminderError as e:
        raise HTTPException(422, str(e))
    return Response(reminders.to_ics(event), media_type="text/calendar",
                    headers={"Content-Disposition": 'attachment; filename="trial-reminder.ics"'})


@app.post("/api/reviews/{review_id}/reminder/approve")
async def approve_reminder(review_id: str, body: ReminderRequest, authorization: str = Header(default="")):
    token = get_settings().operator_token
    if not token:
        raise HTTPException(503, "Calendar approval isn't set up on this server. Download the .ics file instead.")
    if not secrets.compare_digest(authorization.removeprefix("Bearer ").strip(), token):
        raise HTTPException(401, "Only the demo operator can add events to the team calendar.")
    r = _review(review_id)
    try:
        event = reminders.build_event(r, body.trial_end_date, body.timezone, body.days_before)
        return await reminders.approve(event)
    except reminders.ReminderError as e:
        raise HTTPException(422, str(e))
    except reminders.CalendarUnavailable as e:
        raise HTTPException(503, str(e))


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
app.include_router(guard_router)
FRONTEND_DIR = Path(__file__).parent.parent / "frontrend" / "dist"
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
