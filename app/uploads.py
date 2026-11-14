"""Pages a user saved from their own browser (after passing a bot check or signing in).

An upload is served to our browser from memory at a private address. Its scripts are
removed so it shows exactly what the user saw, and it can't fetch, redirect or post anything.
"""

import html as htmllib
import re
import secrets
import time
from dataclasses import dataclass, field

from .config import get_settings

UPLOAD_ORIGIN = "https://saved-page.coercionguard.local"
MAX_BYTES = 8_000_000
SCRIPT = re.compile(r"<script\b[^>]*>.*?</script\s*>|<script\b[^>]*/>", re.I | re.S)
REFRESH = re.compile(r"<meta[^>]+http-equiv\s*=\s*[\"']?refresh[^>]*>", re.I)
TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


@dataclass
class SavedPage:
    id: str
    name: str
    html: str
    created_at: float = field(default_factory=time.time)

    @property
    def url(self) -> str:
        return f"{UPLOAD_ORIGIN}/{self.id}/"

    @property
    def title(self) -> str:
        m = TITLE.search(self.html)
        return htmllib.unescape(re.sub(r"\s+", " ", m.group(1))).strip()[:200] if m else self.name


_pages: dict[str, SavedPage] = {}


def clean(raw: bytes) -> str:
    html = raw.decode("utf-8", errors="replace")
    html = SCRIPT.sub("", html)
    return REFRESH.sub("", html)


def add(name: str, raw: bytes) -> SavedPage:
    if len(raw) > MAX_BYTES:
        raise ValueError("That file is larger than 8 MB.")
    head = raw[:4096].lower()
    if b"<html" not in head and b"<!doctype html" not in head and b"<body" not in head:
        raise ValueError("That file isn't a saved web page. In your browser, use Save Page As and choose a web page (.html).")
    purge()
    page = SavedPage(id=secrets.token_urlsafe(18), name=(name or "saved page")[:120], html=clean(raw))
    _pages[page.id] = page
    return page


def get(page_id: str) -> SavedPage | None:
    p = _pages.get(page_id)
    if p and time.time() - p.created_at >= get_settings().review_ttl_seconds:
        del _pages[page_id]
        return None
    return p


def from_url(url: str) -> SavedPage | None:
    if not url.startswith(UPLOAD_ORIGIN + "/"):
        return None
    return get(url[len(UPLOAD_ORIGIN) + 1:].split("/", 1)[0])


def purge() -> None:
    ttl = get_settings().review_ttl_seconds
    for k in [k for k, p in _pages.items() if time.time() - p.created_at >= ttl]:
        del _pages[k]
