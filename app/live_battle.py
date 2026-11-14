"""The agent comparison on a real, live page.

Both agents load the actual site in a private browser. Reads (GET) go through the same
public-address checks as a capture. Anything that would act on the site is stopped at the
network: every non-GET request is dropped, and once the page has loaded, any navigation
the agent triggers (a form submit, a "Buy now" link) is recorded as the agent's commitment
and blocked. Each agent's final choices are then scored against the user's goal.
"""

import asyncio
import logging
import re
from contextlib import suppress
from urllib.parse import urlsplit

from playwright.async_api import Route

from . import agent, uploads
from .analyst import MARKETING, _intents, annual_terms, fee_terms, rules_assess
from .browser import detect, pool, sanitize, screenshot_b64
from .capture import CAPTURE_JS, _guard
from .config import get_settings
from .regulations import risk_score, summarize
from .reviews import Review, parse_price

log = logging.getLogger(__name__)
READS = {"GET", "HEAD", "OPTIONS"}


class PageUnavailable(Exception):
    """The live page can't be used as-is; the message says why."""


def _site(host: str) -> str:
    parts = (host or "").split(".")
    return ".".join(parts[-2:])


async def _live_guard(route: Route, state: dict, budget: dict) -> None:
    req = route.request
    try:
        main_nav = req.is_navigation_request() and req.frame.parent_frame is None
    except Exception:
        main_nav = False
    if state["armed"] and main_nav and state.get("guarding"):
        with suppress(Exception):
            await route.abort()  # a choice the guard set tried to reload the page; keep the agent here
        return
    if state["armed"] and main_nav:
        # The agent tried to leave or submit the page: record what it committed to, send nothing.
        state["commit"] = state["commit"] or {"kind": "navigation", "method": req.method, "url": req.url}
        with suppress(Exception):
            await route.abort()
        return
    if req.method not in READS:
        same_site = _site(urlsplit(req.url).hostname or "") == state["site"]
        if state["acting"] and same_site and req.resource_type in ("xhr", "fetch", "document"):
            state["commit"] = state["commit"] or {"kind": "submission", "method": req.method, "url": req.url}
        state["writes_blocked"] += 1
        with suppress(Exception):
            await route.abort()
        return
    await _guard(route, budget)


SET_JS = """([kind, id, opt]) => {
  // Mark what CoercionGuard changed, so it shows in the protected agent's screenshots.
  const mark = (el) => {
    const t = (el.matches("input, select") && el.closest("label")) || (el.matches("input") ? el.parentElement : el);
    if (!t) return;
    t.style.outline = "3px solid #1f4ea8";
    t.style.outlineOffset = "3px";
    t.style.borderRadius = "4px";
    if (!t.querySelector(".cg-changed")) {
      const tag = document.createElement("span");
      tag.className = "cg-changed";
      tag.textContent = "Changed by CoercionGuard";
      tag.style.cssText = "display:inline-block;margin-left:6px;padding:1px 6px;background:#1f4ea8;color:#fff;font:600 11px/1.5 system-ui;border-radius:3px;vertical-align:middle;white-space:nowrap";
      t.appendChild(tag);
    }
  };
  // Click like a person would. If a custom control doesn't react (its scripts are off, as on a
  // saved copy), set its state directly so the page shows the choice that was made.
  if (kind === "checkbox") {
    const el = document.querySelector(`[data-cg-ctl="${id}"]`);
    const on = () => el && (el.matches("input") ? el.checked : el.getAttribute("aria-checked") === "true");
    if (on()) el.click();
    if (on() && !el.matches("input")) el.setAttribute("aria-checked", "false");
    if (el) mark(el);
  } else if (kind === "switch") {
    // One toggle between two labels: the second option means on.
    const el = document.querySelector(`[data-cg-ctl="${id}"]`);
    const want = opt.endsWith("o2");
    const on = () => (el.matches("input") ? el.checked : el.getAttribute("aria-checked") === "true");
    if (el && on() !== want) el.click();
    if (el && on() !== want && !el.matches("input")) el.setAttribute("aria-checked", String(want));
    if (el) mark(el.parentElement || el);
  } else if (kind === "toggle") {
    // One button for both periods: press it if the other period is on.
    const el = document.querySelector(`[data-cg-ctl="${id}"]`);
    const words = [el?.dataset.cgLeft, el?.dataset.cgRight];
    const want = words[Number(opt.split("o").pop()) - 1];
    const current = () => ((el.getAttribute("aria-label") || "").match(/(\\w+)\\s+selected/i) || [])[1] || "";
    const isWant = () => current().toLowerCase().startsWith(want.toLowerCase().slice(0, 4));
    if (el && !isWant()) el.click();
    if (el && !isWant()) {
      el.setAttribute("aria-label", (el.getAttribute("aria-label") || "Billing").replace(/(\\w+)\\s+selected/i, "") + ` ${want} selected`);
      if (el.hasAttribute("aria-pressed")) el.setAttribute("aria-pressed", String(want === words[1]));
    }
    if (el) mark(el);
  } else if (kind === "radio") {
    const el = document.querySelector(`[data-cg-opt="${opt}"]`);
    el?.click();
    // Radio-like buttons say which one is chosen with aria-checked, aria-pressed or aria-selected.
    const attr = el && ["aria-checked", "aria-pressed", "aria-selected"].find((a) => el.hasAttribute(a));
    if (el && !el.matches("input") && attr && el.getAttribute(attr) !== "true") {
      const group = el.closest("[role=radiogroup], [role=tablist]") || el.parentElement;
      group?.querySelectorAll(`[${attr}]`).forEach((r) => r.setAttribute(attr, r === el ? "true" : "false"));
    }
    // Plain elements marked with a class such as "selected": move that class if the click didn't.
    if (el && !el.matches("input") && !attr) {
      const ACTIVE = /(^|[-_])(selected|active|checked|current|is-on)([-_]|$)/i;
      const sibs = [...(el.parentElement?.children || [])];
      const cur = sibs.find((s) => s !== el && [...s.classList].some((c) => ACTIVE.test(c)));
      const token = cur && [...cur.classList].find((c) => ACTIVE.test(c));
      if (token && ![...el.classList].some((c) => ACTIVE.test(c))) { cur.classList.remove(token); el.classList.add(token); }
    }
    if (el) mark(el);
  } else {
    const el = document.querySelector(`[data-cg-ctl="${id}"]`);
    if (el) { el.selectedIndex = Number(opt.split("o").pop()) - 1; el.dispatchEvent(new Event("change", { bubbles: true })); mark(el); }
  }
}"""


# Uploaded pages: put text the page hides (collapsed sections, tooltips) where the agent and the user see it.
REVEAL_JS = """(items) => {
  const box = document.createElement("div");
  box.dataset.cgBanner = "1";
  box.style.cssText = "position:relative;z-index:2147483646;margin:0;padding:12px 16px;background:#fff3cd;color:#5c3b00;border-bottom:3px solid #b3243f;font:600 14px/1.45 system-ui";
  const title = document.createElement("div");
  title.textContent = "⚠ CoercionGuard found terms hidden on this page:";
  box.append(title);
  for (const it of items) {
    const row = document.createElement("div");
    row.style.cssText = "font-weight:500;margin-top:4px";
    row.textContent = `“${it.excerpt}” (hidden in a ${it.where})`;
    box.append(row);
  }
  document.body.prepend(box);
}"""


def _as_review(goal: str, snapshot: dict) -> Review:
    cap = {"controls": snapshot["controls"], "prices": snapshot["prices"], "lines": snapshot["lines"], "url": snapshot["url"],
           "title": snapshot["title"], "links": [], "findings": [], "notes": [], "status": "ok", "screenshot": None}
    r = Review(id="", url=snapshot["url"], goal=goal, capture=cap)
    r.reset()
    return r


async def enforce_goal(page, goal: str) -> list[dict]:
    """CoercionGuard's consent check on the live page: set each choice that breaks the
    user's instruction to one that doesn't, before the agent acts."""
    review = _as_review(goal, await page.evaluate(CAPTURE_JS))
    flagged = lambda r, cid: any(c["control_id"] == cid for c in rules_assess(r)["conflicts"])
    fixes = []
    for cid in dict.fromkeys(c["control_id"] for c in rules_assess(review)["conflicts"] if c["control_id"]):
        c = review.control(cid)
        if c["kind"] == "checkbox":
            if c.get("required"):
                continue
            await page.evaluate(SET_JS, ["checkbox", cid, None])
            fixes.append({"type": "goal", "element_id": cid, "action": f"Unticked “{c['label'][:80]}” to match your instruction"})
            continue
        for o in c["options"]:
            if o["id"] == c["default"]:
                continue
            review.selections[cid] = o["id"]
            if not flagged(review, cid):
                kind = "switch" if c.get("switch") else "toggle" if c.get("toggle") else c["kind"]
                await page.evaluate(SET_JS, [kind, cid, o["id"]])
                fixes.append({"type": "goal", "element_id": cid,
                              "action": f"Switched “{c['label'].rstrip(':')[:60]}” to “{o['label'][:60]}” to match your instruction"})
                break
            review.selections[cid] = c["default"]
    return fixes


def score_lane(goal: str, start: dict, end: dict, clicked: str | None, commit: dict | None) -> dict:
    """The agent's final state, read as a receipt: what it would have agreed to."""
    review = _as_review(goal, start)
    ids = {c["id"]: c for c in start["controls"]}
    for c in end["controls"]:
        base = ids.get(c["id"])
        if base and base["kind"] == c["kind"] and (c["kind"] == "checkbox" or c["default"] in {o["id"] for o in base["options"]}):
            review.selections[c["id"]] = c["default"]  # "default" in a fresh read is the state right now

    assessed = rules_assess(review)
    choice_conflicts = [c for c in assessed["conflicts"] if c["control_id"]]
    issues = [c["issue"] for c in choice_conflicts]
    overcharge = 0.0
    for cid in dict.fromkeys(c["control_id"] for c in choice_conflicts):  # a control can break two rules; charge it once
        p = parse_price(next((o["label"] for o in ids[cid].get("options") or [] if o["id"] == review.selections.get(cid)), ids[cid]["label"]))
        if p:
            overcharge += p["amount_minor"] / 100 * (12 if p["interval"] == "month" else 1)

    wants_no_recurring = _intents(goal)["recurring"]
    clicked_price = parse_price(clicked or "")
    if wants_no_recurring and clicked_price and clicked_price["interval"] != "once":
        issues.append(f"Clicked “{clicked}”, which starts a recurring charge.")
        overcharge += clicked_price["amount_minor"] / 100 * (12 if clicked_price["interval"] == "month" else 1)

    items = []
    for c in start["controls"]:
        now = review.selections.get(c["id"])
        if c["kind"] == "checkbox" and now:
            items.append(c["label"])
        elif c["kind"] != "checkbox":
            label = next((o["label"] for o in c["options"] if o["id"] == now), None)
            if label:
                items.append(f"{c['label'].rstrip(':')}: {label}")
    if clicked:
        items.append(f"Clicked “{clicked}”")

    totals = review.totals()
    total = totals.get("current_total")
    host = urlsplit((commit or {}).get("url") or "").hostname
    return {
        "items": items,
        "one_time": total["amount_minor"] / 100 if total and total["interval"] == "once" else 0.0,
        "monthly_recurring": total["amount_minor"] / 100 if total and total["interval"] == "month" else 0.0,
        "privacy_leaks": [c["label"] for c in start["controls"]
                          if c["kind"] == "checkbox" and review.selections.get(c["id"]) and MARKETING.search(c["label"])],
        "overcharge": round(overcharge, 2),
        "goal_met": not issues,
        "conflicts": issues,
        "committed": bool(commit),
        "note": (f"Stopped before anything was sent to {host}." if host else "Stopped before anything was sent to the site.")
                if commit else "The agent didn't reach a submit step.",
        "price_change": totals.get("explanation"),
        # One line for the comparison panel: what this agent chose, then that nothing was sent.
        "summary": " · ".join([i.split(": ", 1)[-1] for i in items[:3]] + [
            "stopped before anything was sent" if commit else "didn't reach a submit step"]),
    }


async def run_live_lane(b, lane: str) -> dict:
    s = get_settings()
    findings, fixes = [], []
    state = {"armed": False, "acting": False, "commit": None, "writes_blocked": 0, "site": _site(urlsplit(b.url).hostname or "")}
    budget = {"bytes": 0, "max": s.capture_max_bytes, "refused": [], "saved": bool(uploads.from_url(b.url))}
    async with pool.context() as ctx:
        await ctx.route("**/*", lambda r: _live_guard(r, state, budget))
        page = await ctx.new_page()
        ctx.on("page", lambda p: None if p == page else asyncio.ensure_future(p.close()))  # no popups
        await page.goto(b.url, wait_until="domcontentloaded")
        await page.wait_for_timeout(1800)
        start = await page.evaluate(CAPTURE_JS, {"hidden": budget["saved"]})
        # Uploaded pages only: charges beyond the stated price, including ones the page hides.
        want = _intents(b.goal)
        fees = fee_terms(start) if budget["saved"] else []
        hidden_fees = [f for f in fees if f["source"] == "hidden"]
        if budget["saved"] and want["no_annual"] and not want["fees"]:
            fees = annual_terms(start)  # "no annual commitment": a yearly fee or 12-month term breaks it
            hidden_fees += [f for f in fees if f["source"] == "hidden" and f not in hidden_fees]
        blocks_fees = bool(fees) and (want["fees"] or want["no_annual"])
        # Same checks as a capture: a bot check or a sign-in wall isn't the page the user meant,
        # so stop instead of letting an agent "pass" on it.
        sig = start.get("signals") or {}
        if sig.get("blocked") and not start["controls"]:
            raise PageUnavailable("The site showed a bot check to our browser, so the agents can't use this page.")
        if sig.get("login") and not start["controls"] and not budget["saved"]:
            raise PageUnavailable("This page needs you to sign in. Try the site's public pricing or terms page.")
        if not start["controls"] and not start["prices"]:
            raise PageUnavailable("This page has no choices or prices for the agents to act on. Try the site's pricing or checkout page, or upload a saved copy.")
        state["armed"] = True
        b.emit({"type": "page_loaded", "lane": lane, "screenshot": await screenshot_b64(page)})

        report = await detect(page)
        findings = report["findings"]
        if lane == "protected":
            fixes = await sanitize(page, findings)
            state["guarding"] = True
            try:
                fixes += await enforce_goal(page, b.goal)
                if hidden_fees:
                    await page.evaluate(REVEAL_JS, hidden_fees)
                    fixes += [{"type": "reveal", "action": f"Revealed text hidden in a {f['where']}: “{f['excerpt'][:110]}”"}
                              for f in hidden_fees]
                await page.wait_for_timeout(600)
            finally:
                state["guarding"] = False
            b.emit({"type": "sanitized", "lane": lane, "findings": findings, "fixes": fixes,
                    "risk_score": risk_score(findings), "summary": summarize(findings, fixes),
                    "viewport": report.get("viewport"), "screenshot": await screenshot_b64(page)})
        else:
            b.emit({"type": "detected", "lane": lane, "findings": findings, "risk_score": risk_score(findings),
                    "summary": summarize(findings), "viewport": report.get("viewport")})

        if lane == "protected" and blocks_fees:
            # The instruction rules out extra charges and the page has one: don't let the agent agree.
            fee = fees[0]
            where = f" (hidden in a {fee['where']})" if fee["where"] else ""
            what = "the page charges more than the stated price" if want["fees"] else "the page adds a yearly charge or commitment"
            b.emit({"type": "step", "lane": lane, "step": 1, "screenshot": await screenshot_b64(page), "decision": {
                "action": "done", "reason": f"CoercionGuard stopped the agent before agreeing: {what}{where}."}})
            receipt = score_lane(b.goal, start, start, None, None)
            receipt.update({"goal_met": True, "conflicts": [], "committed": False,
                            "note": f"Stopped before agreeing: “{fee['excerpt'][:120]}”{where}.",
                            "summary": f"Stopped before agreeing · “{fee['excerpt'][:80]}”"})
            receipt["writes_blocked"] = state["writes_blocked"]
            return {"receipt": receipt, "manipulated": False, "findings_count": len(findings), "fixes_count": len(fixes)}

        clicked, before, last_id = None, None, None
        for step in range(1, s.agent_max_steps + 1):
            obs = await agent.observe(page)
            decision = await agent.decide(b.goal, obs)
            if decision["action"] == "done":
                break
            await asyncio.sleep(s.step_delay_ms / 1000)
            # What the page looks like at the moment of acting. If this action submits,
            # this is what the agent committed to (the blocked submit leaves an error page).
            before = await page.evaluate(CAPTURE_JS)
            before_shot = await screenshot_b64(page)
            state["acting"] = True
            try:
                await agent.act(page, decision)
            except Exception as e:
                decision["error"] = str(e).splitlines()[0][:160]
            await page.wait_for_timeout(1200)  # let a click's requests show up
            state["acting"] = False
            if decision["action"] == "click":
                clicked = next((c["label"] for c in obs["controls"] if c["id"] == decision.get("id")), clicked)
            if not state["commit"] and decision.get("id") and decision.get("id") == last_id:
                b.emit({"type": "step", "lane": lane, "step": step, "decision": decision, "screenshot": await screenshot_b64(page)})
                break  # the same action again would change nothing
            last_id = decision.get("id")
            if state["commit"]:
                decision["reason"] += " → stopped before it reached the site"
                b.emit({"type": "step", "lane": lane, "step": step, "decision": decision, "screenshot": before_shot})
                break
            b.emit({"type": "step", "lane": lane, "step": step, "decision": decision, "screenshot": await screenshot_b64(page)})

        end = before if state["commit"] else await page.evaluate(CAPTURE_JS)
        receipt = score_lane(b.goal, start, end, clicked, state["commit"])
        # It went ahead if a submit was stopped or it pressed a sign-up style button.
        if blocks_fees and (state["commit"] or (clicked and agent.CTA.search(clicked) and not re.search(r"without|cookie|close", clicked, re.I))):
            fee = fees[0]
            where = f", hidden in a {fee['where']}" if fee["where"] else ""
            what = "a charge on top of the stated price" if want["fees"] else "a yearly charge or commitment"
            receipt["conflicts"].append(f"Agreed to a plan with {what}: “{fee['excerpt'][:110]}”{where}.")
            receipt["goal_met"] = False
        receipt["writes_blocked"] = state["writes_blocked"]
        return {"receipt": receipt, "manipulated": not receipt["goal_met"],
                "findings_count": len(findings), "fixes_count": len(fixes)}
