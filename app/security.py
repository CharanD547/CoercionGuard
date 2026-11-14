"""SSRF guard for user-submitted URLs, plus a small in-memory rate limiter."""

import asyncio
import ipaddress
import socket
import time
from collections import defaultdict, deque
from urllib.parse import urlsplit

from .config import get_settings


class UnsafeURL(ValueError):
    pass


def _ip_is_public(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    return addr.is_global and not addr.is_multicast


async def check_public_url(url: str) -> str:
    if not url or len(url) > 2048:
        raise UnsafeURL("URL is missing or too long")
    if any(c in url for c in "\r\n\t "):
        raise UnsafeURL("URL contains whitespace")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise UnsafeURL("Only http(s) URLs are allowed")
    if parts.username or parts.password:
        raise UnsafeURL("URLs with credentials are not allowed")
    if not parts.hostname:
        raise UnsafeURL("URL has no host")
    if get_settings().allow_private_urls:
        return url
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(parts.hostname, parts.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise UnsafeURL(f"Cannot resolve host: {parts.hostname}") from e
    for info in infos:
        if not _ip_is_public(info[4][0]):
            raise UnsafeURL("URL resolves to a private or reserved address")
    return url


async def is_public_host(host: str) -> bool:
    """Used per sub-request during live scans so redirects can't reach internal hosts."""
    if get_settings().allow_private_urls:
        return True
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return False
    return all(_ip_is_public(i[4][0]) for i in infos)


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        limit = get_settings().rate_limit_per_minute
        now = time.monotonic()
        if len(self._hits) > 500:
            stale = [k for k, q in self._hits.items() if not q or now - q[-1] > 60]
            for k in stale:
                del self._hits[k]
        q = self._hits[key]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True


limiter = RateLimiter()
