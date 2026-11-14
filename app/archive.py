"""Finds the Internet Archive's latest copy of a page, for sites that block automated browsers."""

import httpx

from .capture import archive_date

AVAILABLE = "https://archive.org/wayback/available"


async def latest_copy(url: str) -> dict | None:
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        resp = await client.get(AVAILABLE, params={"url": url})
        resp.raise_for_status()
    snap = (resp.json().get("archived_snapshots") or {}).get("closest") or {}
    if not snap.get("available") or str(snap.get("status")) != "200":
        return None
    ts = str(snap["timestamp"])
    # "if_" serves the archived page without the archive's toolbar, with its links rewritten to the archive.
    copy = f"https://web.archive.org/web/{ts}if_/{url}"
    return {"url": copy, "timestamp": ts, "date": archive_date(copy)}
