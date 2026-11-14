"""One-shot scan: load a page (live URL or sandbox), detect dark patterns, return an annotated report."""

from urllib.parse import urlsplit

from playwright.async_api import Route

from .browser import detect, pool, sandbox_url, sanitize, screenshot_b64
from .regulations import risk_score
from .security import is_public_host

BLOCKED_RESOURCE_TYPES = {"media", "font"}


async def _guard_live(route: Route) -> None:
    req = route.request
    if req.resource_type in BLOCKED_RESOURCE_TYPES:
        await route.abort()
        return
    host = urlsplit(req.url).hostname or ""
    if req.url.startswith(("data:", "blob:")) or await is_public_host(host):
        await route.continue_()
    else:
        await route.abort()


async def scan(*, url: str | None = None, sandbox_id: str | None = None) -> dict:
    live = url is not None
    async with pool.context(sandboxed=not live) as ctx:
        if live:
            await ctx.route("**/*", _guard_live)
        page = await ctx.new_page()
        target = url if live else sandbox_url(sandbox_id)
        try:
            await page.goto(target, wait_until="domcontentloaded")
            await page.wait_for_timeout(1500)  # let late-rendering banners/timers appear
        except Exception as e:
            return {"status": "unreachable", "target": target, "error": str(e).splitlines()[0],
                    "hint": "Try one of the cached sandbox pages instead."}

        report = await detect(page)
        if report["blocked"] and not report["findings"]:
            return {
                "status": "blocked", "target": target, "title": report["title"],
                "screenshot": await screenshot_b64(page),
                "hint": "The site served a CAPTCHA/bot check to our headless browser. Try a sandbox page.",
            }

        before = await screenshot_b64(page)
        fixes = await sanitize(page, report["findings"])
        after = await screenshot_b64(page)

    by_type: dict[str, int] = {}
    for f in report["findings"]:
        by_type[f["type"]] = by_type.get(f["type"], 0) + 1

    return {
        "status": "ok",
        "target": target,
        "title": report["title"],
        "risk_score": risk_score(report["findings"]),
        "counts": by_type,
        "findings": report["findings"],
        "fixes": fixes,
        "screenshot_before": before,
        "screenshot_after": after,
    }
