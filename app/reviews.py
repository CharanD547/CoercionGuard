"""Private, short-lived reviews of a captured page: the user's goal, the page's defaults,
the user's own selections, and price changes that the captured text actually supports."""

import re
import secrets
import time
from dataclasses import dataclass, field

from .config import get_settings

SYMBOLS = {"$": "$", "€": "€", "£": "£", "₹": "₹", "¥": "¥"}
PRICE_RE = re.compile(
    r"(?P<sign>[+\-−]\s?)?(?P<sym>[$€£₹¥])\s?(?P<num>\d[\d,]*(?:\.\d{1,2})?)"
    r"|(?P<num2>\d[\d,]*(?:\.\d{1,2})?)\s?(?P<code>USD|EUR|GBP|INR|CAD|AUD)\b", re.I)
INTERVALS = [
    ("month", re.compile(r"(/\s?(mo|month)\b|per month|a month|monthly|each month)", re.I)),
    ("year", re.compile(r"(/\s?(yr|year)\b|per year|a year|annual(ly)?|yearly)", re.I)),
    ("week", re.compile(r"(/\s?(wk|week)\b|per week|a week|weekly)", re.I)),
]
# Wording that makes a figure's relationship to the choice unclear.
AMBIGUOUS = re.compile(r"\b(save|saving|off|discount|was|from|starting at|up to|free for|first \d+)\b", re.I)


def parse_price(text: str) -> dict | None:
    """The single price a label states, or None if it states none or several, or hedges it."""
    matches = list(PRICE_RE.finditer(text or ""))
    if len(matches) != 1 or AMBIGUOUS.search(text):
        return None
    m = matches[0]
    num = (m.group("num") or m.group("num2")).replace(",", "")
    currency = SYMBOLS.get(m.group("sym") or "", (m.group("code") or "").upper())
    if m.group("sign") and m.group("sign").strip() in "-−":
        return None  # a credit or discount; we don't guess how it applies
    interval = next((name for name, rx in INTERVALS if rx.search(text)), "once")
    return {"amount_minor": round(float(num) * 100), "currency": currency, "interval": interval, "text": text}


def money(amount_minor: int, currency: str) -> str:
    v = f"{abs(amount_minor) / 100:,.2f}".removesuffix(".00")
    sign = "-" if amount_minor < 0 else ""
    return f"{sign}{currency}{v}" if len(currency) == 1 else f"{sign}{v} {currency}"


@dataclass
class Review:
    id: str
    url: str
    goal: str
    capture: dict
    created_at: float = field(default_factory=time.time)
    selections: dict = field(default_factory=dict)
    linked: dict | None = None  # the one extra page the agent may read
    assessment: dict | None = None

    @property
    def expires_at(self) -> float:
        return self.created_at + get_settings().review_ttl_seconds

    @property
    def defaults(self) -> dict:
        return {c["id"]: c["default"] for c in self.capture["controls"]}

    def control(self, cid: str) -> dict | None:
        return next((c for c in self.capture["controls"] if c["id"] == cid), None)

    def set_selections(self, changes: dict) -> None:
        for cid, value in changes.items():
            c = self.control(cid)
            if not c:
                raise ValueError(f"Unknown control {cid}")
            if c["kind"] == "checkbox":
                if not isinstance(value, bool):
                    raise ValueError(f"{cid} takes true or false")
            elif value not in {o["id"] for o in c["options"]}:
                raise ValueError(f"{value!r} isn't an option of {cid}")
            self.selections[cid] = value

    def reset(self) -> None:
        self.selections = dict(self.defaults)

    def changed(self) -> list[dict]:
        return [c for c in self.capture["controls"] if self.selections.get(c["id"]) != c["default"]]

    def totals(self) -> dict:
        """Price change from the page defaults, only where the captured text states the amounts."""
        changes, unknown = [], []
        for c in self.changed():
            now = self.selections.get(c["id"])
            if c["kind"] == "checkbox":
                p = parse_price(c["label"])
                if not p:
                    unknown.append({"control_id": c["id"], "label": c["label"], "reason": "The label doesn't state one clear price."})
                    continue
                delta = p["amount_minor"] if now else -p["amount_minor"]
                changes.append({"control_id": c["id"], "label": c["label"], "delta_minor": delta,
                                "currency": p["currency"], "interval": p["interval"]})
            else:
                old = next((o for o in c["options"] if o["id"] == c["default"]), None)
                new = next((o for o in c["options"] if o["id"] == now), None)
                po, pn = parse_price(old["label"]) if old else None, parse_price(new["label"]) if new else None
                if not (po and pn) or (po["currency"], po["interval"]) != (pn["currency"], pn["interval"]):
                    unknown.append({"control_id": c["id"], "label": c["label"],
                                    "reason": "The options don't state comparable prices."})
                    continue
                changes.append({"control_id": c["id"], "label": f"{c['label']}: {new['label']}",
                                "delta_minor": pn["amount_minor"] - po["amount_minor"],
                                "currency": pn["currency"], "interval": pn["interval"]})

        totals = [p for p in map(parse_price, self.capture["prices"]) if p and re.search(r"\btotal\b", p["text"], re.I)]
        default_total = totals[0] if totals else None
        out = {"changes": changes, "unknown": unknown, "known": not unknown,
               "default_total": default_total, "current_total": None}
        for ch in changes:
            ch["display"] = money(ch["delta_minor"], ch["currency"]) + ("" if ch["interval"] == "once" else f"/{ch['interval']}")
        if unknown:
            out["explanation"] = "The resulting price is unknown: " + " ".join(u["reason"] for u in unknown)
        elif not changes:
            out["explanation"] = "Your selections match the page defaults."
            out["current_total"] = default_total
        elif default_total and all((ch["currency"], ch["interval"]) == (default_total["currency"], default_total["interval"]) for ch in changes):
            amount = default_total["amount_minor"] + sum(ch["delta_minor"] for ch in changes)
            out["current_total"] = {**default_total, "amount_minor": amount, "text": money(amount, default_total["currency"])}
            out["explanation"] = f"Total goes from {money(default_total['amount_minor'], default_total['currency'])} to {out['current_total']['text']}."
        else:
            out["explanation"] = "Each change's price is shown, but the page doesn't state a total they apply to."
        return out

    def public(self, *, screenshot: bool = True) -> dict:
        cap = self.capture
        return {
            "id": self.id, "url": self.url, "final_url": cap["url"], "title": cap["title"], "goal": self.goal,
            "status": cap["status"], "notes": cap["notes"], "expires_at": round(self.expires_at),
            "controls": cap["controls"], "defaults": self.defaults, "selections": self.selections,
            "changed": [c["id"] for c in self.changed()], "totals": self.totals(),
            "prices": cap["prices"][:40], "links": cap["links"], "findings": cap["findings"],
            "linked_page": {"url": self.linked["url"], "title": self.linked["title"]} if self.linked else None,
            "assessment": self.assessment,
            "screenshot": cap["screenshot"] if screenshot else None,
        }


class ReviewStore:
    def __init__(self) -> None:
        self._items: dict[str, Review] = {}

    def create(self, url: str, goal: str, capture: dict) -> Review:
        self.purge()
        r = Review(id=secrets.token_urlsafe(18), url=url, goal=goal, capture=capture)
        r.reset()
        self._items[r.id] = r
        return r

    def get(self, rid: str) -> Review | None:
        r = self._items.get(rid)
        if r and time.time() >= r.expires_at:
            del self._items[rid]
            return None
        return r

    def purge(self) -> int:
        now = time.time()
        dead = [k for k, r in self._items.items() if now >= r.expires_at]
        for k in dead:
            del self._items[k]
        return len(dead)


store = ReviewStore()
