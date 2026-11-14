"""Renewal reminders: a previewable event, an .ics download for anyone, and an
operator-approved write to the team Google Calendar that can be retried safely."""

import asyncio
import hashlib
import json
import time
from datetime import date, datetime, timedelta, timezone
from datetime import time as dtime
from pathlib import Path
from urllib.parse import quote, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

from .config import get_settings
from .reviews import Review

CAL_API = "https://www.googleapis.com/calendar/v3/calendars"


class ReminderError(ValueError):
    pass


class CalendarUnavailable(RuntimeError):
    pass


def build_event(review: Review, trial_end: str, tz_name: str, days_before: int = 2) -> dict:
    follow = (review.assessment or {}).get("follow_up")
    if not follow:
        raise ReminderError("Check the choices first. A reminder is offered only when the page's renewal terms are cited.")
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ReminderError(f"Unknown time zone {tz_name!r}. Use a name like America/New_York.")
    try:
        end = date.fromisoformat(trial_end)
    except ValueError:
        raise ReminderError("Give the trial end date as YYYY-MM-DD.")
    if not 0 <= days_before <= 30:
        raise ReminderError("Remind between 0 and 30 days before the trial ends.")
    today = datetime.now(tz).date()
    if end < today:
        raise ReminderError("That trial end date has already passed.")
    remind_on = max(end - timedelta(days=days_before), today)
    start = datetime.combine(remind_on, dtime(9, 0), tz)
    if start <= datetime.now(tz):
        start = (datetime.now(tz) + timedelta(minutes=30)).replace(second=0, microsecond=0)

    page = review.capture["url"]
    parts = urlsplit(page)
    canonical = f"{parts.scheme}://{parts.hostname}{parts.path}".rstrip("/")
    site = (parts.hostname or "the site").removeprefix("www.")
    # Same page, date, zone and lead time always give the same ID, so retries can't duplicate.
    event_id = "cg" + hashlib.sha256(f"{canonical}|{end}|{tz_name}|{days_before}".encode()).hexdigest()[:40]
    quote_text = follow["evidence"]["excerpt"]
    description = "\n".join([
        f"Your trial on {site} ends {end:%A, %B} {end.day}.",
        f"Your goal: {review.goal}",
        f"What the page says: \u201c{quote_text}\u201d",
        f"Page: {page}",
        "Cancel before the trial ends if you don't want to be charged.",
        "Created by CoercionGuard.",
    ])
    return {
        "id": event_id,
        "summary": f"Trial ends {end:%b} {end.day}: cancel or keep {site}",
        "description": description,
        "start": {"dateTime": start.isoformat(), "timeZone": tz_name},
        "end": {"dateTime": (start + timedelta(minutes=30)).isoformat(), "timeZone": tz_name},
        "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 0}]},
        "source": {"title": "CoercionGuard review", "url": page},
    }


def _ics_text(s: str) -> str:
    return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _fold(line: str) -> str:
    out, raw = [], line.encode()
    while len(raw) > 75:
        cut = 75
        while (raw[cut] & 0xC0) == 0x80:  # don't split a UTF-8 character
            cut -= 1
        out.append(raw[:cut].decode())
        raw = b" " + raw[cut:]
    out.append(raw.decode())
    return "\r\n".join(out)


def to_ics(event: dict) -> str:
    utc = lambda iso: datetime.fromisoformat(iso).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CoercionGuard//Renewal reminder//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
        "BEGIN:VEVENT", f"UID:{event['id']}@coercionguard",
        f"DTSTAMP:{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}",
        f"DTSTART:{utc(event['start']['dateTime'])}", f"DTEND:{utc(event['end']['dateTime'])}",
        f"SUMMARY:{_ics_text(event['summary'])}", f"DESCRIPTION:{_ics_text(event['description'])}",
        f"URL:{event['source']['url']}",
        "BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{_ics_text(event['summary'])}", "TRIGGER:PT0M", "END:VALARM",
        "END:VEVENT", "END:VCALENDAR",
    ]
    return "\r\n".join(_fold(l) for l in lines) + "\r\n"


# Operator receipts outlive the one-hour review so a retry can be reconciled.
def _receipts() -> dict:
    p = Path(get_settings().receipts_path)
    try:
        return json.loads(p.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_receipt(receipt: dict) -> None:
    p = Path(get_settings().receipts_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    data = _receipts()
    data[receipt["event_id"]] = receipt
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(p)


def _access_token() -> str:
    from google.auth.transport.requests import Request
    from google.oauth2 import service_account

    raw = get_settings().google_service_account_json.strip()
    info = json.loads(raw) if raw.startswith("{") else json.loads(Path(raw).read_text())
    creds = service_account.Credentials.from_service_account_info(info, scopes=["https://www.googleapis.com/auth/calendar.events"])
    creds.refresh(Request())
    return creds.token


async def approve(event: dict) -> dict:
    s = get_settings()
    known = _receipts().get(event["id"])
    if known:
        return {**known, "status": "already_created"}
    if not (s.google_calendar_id and s.google_service_account_json):
        raise CalendarUnavailable("The team calendar isn't configured on this server.")
    token = await asyncio.to_thread(_access_token)
    base = f"{CAL_API}/{quote(s.google_calendar_id, safe='')}/events"
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(base, headers=headers, json=event)
        status = "created"
        if resp.status_code == 409:  # the stable ID already exists: this is a retry
            resp = await client.get(f"{base}/{event['id']}", headers=headers)
            status = "already_created"
            if resp.status_code == 200 and resp.json().get("status") == "cancelled":
                resp = await client.put(f"{base}/{event['id']}", headers=headers, json={**event, "status": "confirmed"})
                status = "restored"
        if resp.status_code >= 400:
            raise CalendarUnavailable(f"Google Calendar answered {resp.status_code}: {resp.text[:200]}")
        body = resp.json()
    receipt = {"event_id": event["id"], "html_link": body.get("htmlLink"), "calendar_id": s.google_calendar_id,
               "summary": event["summary"], "start": event["start"], "created_at": round(time.time())}
    _save_receipt(receipt)
    return {**receipt, "status": status}
