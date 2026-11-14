"""Captures a public page into plain data: text, choice controls, prices, links and a screenshot.

Each capture runs in a fresh browser context with no cookies or credentials. Every network
hop, including each redirect and subresource, must resolve to a public address.
"""

import asyncio
import base64
import re
from contextlib import suppress
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import Route

from . import uploads
from .browser import detect, pool
from .config import get_settings
from .security import UnsafeURL, check_public_url, is_public_host

CAPTURE_JS = (Path(__file__).parent / "js" / "capture.js").read_text(encoding="utf-8")
SKIP_TYPES = {"media", "font", "websocket", "eventsource", "manifest", "other"}


class CaptureError(Exception):
    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status


async def _guard(route: Route, budget: dict) -> None:
    try:
        await _check_hop(route, budget)
    except Exception:
        # The capture may already be finished and its context closed; a late request
        # must not leak an error into the next capture.
        with suppress(Exception):
            await route.abort()


async def _check_hop(route: Route, budget: dict) -> None:
    req = route.request
    if req.url.startswith(uploads.UPLOAD_ORIGIN + "/"):
        saved = uploads.from_url(req.url)
        if saved and req.resource_type == "document":
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=saved.html)
        else:
            await route.abort()
        return
    if budget.get("saved") and req.resource_type not in ("stylesheet", "image"):
        await route.abort()  # an uploaded page may only pull in its own look, nothing that runs or sends
        return
    if req.resource_type in SKIP_TYPES or budget["bytes"] > budget["max"]:
        await route.abort()
        return
    if req.url.startswith(("data:", "blob:")):
        await route.continue_()
        return
    host = urlsplit(req.url).hostname or ""
    if not await is_public_host(host):
        budget["refused"].append(host)
        await route.abort()
        return
    try:
        # Fetch without following redirects, so the browser re-requests each Location
        # and every hop comes back through this check.
        resp = await route.fetch(max_redirects=0, timeout=15_000)
    except Exception:
        await route.abort()
        return
    body = await resp.body()
    budget["bytes"] += len(body)
    await route.fulfill(response=resp, body=body)


async def capture_page(url: str, *, with_screenshot: bool = True) -> dict:
    """Returns the captured data, or raises CaptureError with a status the UI can explain."""
    s = get_settings()
    saved = uploads.from_url(url)
    if url.startswith(uploads.UPLOAD_ORIGIN) and not saved:
        raise CaptureError("rejected", "That uploaded page has expired. Upload it again.")
    if not saved:
        try:
            url = await check_public_url(url)
        except UnsafeURL as e:
            raise CaptureError("rejected", str(e))
        if urlsplit(url).scheme != "https" and not s.allow_private_urls:
            raise CaptureError("rejected", "Use an https:// address.")

    async def run() -> dict:
        budget = {"bytes": 0, "max": s.capture_max_bytes, "refused": [], "saved": bool(saved)}
        async with pool.context() as ctx:
            await ctx.route("**/*", lambda r: _guard(r, budget))
            page = await ctx.new_page()
            try:
                resp = await page.goto(url, wait_until="domcontentloaded")
                await page.wait_for_timeout(1800)  # late-rendering prices and banners
            except Exception as e:
                raise CaptureError("unreachable", f"The page didn't load: {str(e).splitlines()[0][:160]}")
            if resp is not None and resp.status in (401, 403):
                raise CaptureError("blocked", f"The site refused the capture (HTTP {resp.status}).")
            if resp is not None and resp.status >= 400:
                raise CaptureError("unreachable", f"The site answered HTTP {resp.status}.")
            data = await page.evaluate(CAPTURE_JS, {"hidden": bool(saved)})
            report = await detect(page)
            data["findings"] = report["findings"]
            data["screenshot"] = (base64.b64encode(await page.screenshot(type="jpeg", quality=70)).decode()
                                  if with_screenshot else None)
            data["bytes"] = budget["bytes"]
            return data

    try:
        data = await asyncio.wait_for(run(), timeout=s.capture_timeout_seconds)
    except asyncio.TimeoutError:
        raise CaptureError("unreachable", "The page took too long to load.")

    sig = data.pop("signals")
    if sig["blocked"] and not data["controls"]:
        raise CaptureError("blocked", "The site showed a bot check to our browser, so it can't be captured.")
    data["status"] = "ok"
    data["notes"] = source_notes(url)
    if sig["login"] and not saved:  # an upload was saved by someone already signed in
        data["status"] = "login_required" if not data["controls"] else "ok"
        data["notes"].append("This page asks you to sign in. Only what's shown before sign-in was captured.")
    if sig["submit_only"]:
        data["notes"].append("The page says some terms appear only after you submit. Try the site's public terms or pricing page.")
    if not data["controls"] and data["status"] == "ok":
        data["status"] = "no_controls"
        data["notes"].append("No choices (checkboxes, plan options or menus) were found on this page.")
    return data


def source_notes(url: str) -> list[str]:
    """Say where the page came from when it isn't the live site."""
    saved = uploads.from_url(url)
    if saved:
        return [f"This is the copy of the page you saved ({saved.name}). Its scripts are off, so it shows what was on screen when you saved it."]
    archived = archive_date(url)
    if archived:
        return [f"This is the Internet Archive's copy from {archived}. The live page may have changed since."]
    return []


def archive_date(url: str) -> str | None:
    parts = urlsplit(url)
    m = re.match(r"/web/(\d{8})", parts.path) if parts.hostname == "web.archive.org" else None
    if not m:
        return None
    d = m.group(1)
    months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    return f"{months[int(d[4:6]) - 1]} {int(d[6:8])}, {d[:4]}"
