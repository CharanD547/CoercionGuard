"""One shared Chromium, with a semaphore capping concurrent contexts so a small VM doesn't run out of RAM."""

import asyncio
import base64
from contextlib import asynccontextmanager
from pathlib import Path

from playwright.async_api import Browser, BrowserContext, Page, Playwright, Route, async_playwright

from . import sandbox
from .config import get_settings
from .regulations import enrich

JS_DIR = Path(__file__).parent / "js"
DETECTOR_JS = (JS_DIR / "detector.js").read_text()
SANITIZER_JS = (JS_DIR / "sanitizer.js").read_text()


class BrowserPool:
    def __init__(self) -> None:
        self._pw: Playwright | None = None
        self._browser: Browser | None = None
        self._sem = asyncio.Semaphore(get_settings().max_concurrent_contexts)

    async def start(self) -> None:
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.launch(
            headless=get_settings().headless, args=["--disable-dev-shm-usage", "--no-sandbox"]
        )

    async def stop(self) -> None:
        if self._browser:
            await self._browser.close()
        if self._pw:
            await self._pw.stop()

    @property
    def queued(self) -> int:
        return len(self._sem._waiters or [])  # noqa: SLF001

    @asynccontextmanager
    async def context(self, *, sandboxed: bool = False):
        assert self._browser, "BrowserPool not started"
        async with self._sem:
            ctx = await self._browser.new_context(viewport={"width": 1100, "height": 800}, java_script_enabled=True)
            ctx.set_default_timeout(get_settings().page_timeout_ms)
            if sandboxed:
                await ctx.route("**/*", _serve_sandbox)
            try:
                yield ctx
            finally:
                await ctx.close()


async def _serve_sandbox(route: Route) -> None:
    """Serves sandbox pages and checkouts in-process; blocks everything else."""
    req = route.request
    if not req.url.startswith(sandbox.SANDBOX_ORIGIN + "/"):
        await route.abort()
        return
    path, _, query = req.url[len(sandbox.SANDBOX_ORIGIN) + 1:].partition("?")
    sandbox_id, _, rest = path.partition("/")
    if sandbox_id not in sandbox.SANDBOXES:
        await route.fulfill(status=404, body="not found")
        return
    if rest == "submit":
        form = sandbox.parse_form(req.post_data_buffer or b"", query)
        receipt = sandbox.checkout(sandbox_id, form)
        await route.fulfill(status=200, content_type="text/html", body=sandbox.receipt_html(receipt))
    else:
        await route.fulfill(status=200, content_type="text/html", body=sandbox.page_html(sandbox_id))


def sandbox_url(sandbox_id: str) -> str:
    # Trailing slash so the form's relative action="submit" resolves to /<id>/submit.
    return f"{sandbox.SANDBOX_ORIGIN}/{sandbox_id}/"


async def detect(page: Page) -> dict:
    raw = await page.evaluate(DETECTOR_JS)
    raw["findings"] = [enrich(f) for f in raw["findings"]]
    return raw


async def sanitize(page: Page, findings: list[dict]) -> list[dict]:
    return await page.evaluate(SANITIZER_JS, findings)


async def screenshot_b64(page: Page) -> str:
    data = await page.screenshot(type="jpeg", quality=60, full_page=False)
    return base64.b64encode(data).decode()


pool = BrowserPool()
