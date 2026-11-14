"""Split-screen battle: the same agent runs the same task on the raw page and on the
CoercionGuard-sanitised page, at the same time. Every step is streamed as an event."""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field

from . import agent, sandbox
from .browser import detect, pool, sandbox_url, sanitize, screenshot_b64
from .config import get_settings
from .regulations import risk_score

log = logging.getLogger(__name__)
LANES = ("unprotected", "protected")
MAX_STORED_BATTLES = 200


@dataclass
class Battle:
    id: str
    sandbox_id: str
    goal: str
    status: str = "queued"  # queued | running | finished | error
    created_at: float = field(default_factory=time.time)
    events: list[dict] = field(default_factory=list)
    results: dict = field(default_factory=dict)
    _subscribers: set[asyncio.Queue] = field(default_factory=set)

    def emit(self, event: dict) -> None:
        event = {"battle_id": self.id, "ts": round(time.time(), 3), **event}
        self.events.append(event)
        for q in self._subscribers:
            q.put_nowait(event)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        for e in self.events:  # replay so late joiners see the whole run
            q.put_nowait(e)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def summary(self) -> dict:
        return {
            "id": self.id, "sandbox_id": self.sandbox_id, "goal": self.goal,
            "status": self.status, "created_at": self.created_at, "results": self.results,
        }


battles: dict[str, Battle] = {}


def create_battle(sandbox_id: str, goal: str | None) -> Battle:
    box = sandbox.SANDBOXES[sandbox_id]
    b = Battle(id=uuid.uuid4().hex[:12], sandbox_id=sandbox_id, goal=goal or box["goal"])
    battles[b.id] = b
    if len(battles) > MAX_STORED_BATTLES:
        battles.pop(next(iter(battles)))
    return b


async def run_battle(b: Battle) -> None:
    b.status = "running"
    b.emit({"type": "battle_started", "sandbox_id": b.sandbox_id, "goal": b.goal, "queue_position": pool.queued})
    try:
        await asyncio.gather(*(_run_lane(b, lane) for lane in LANES))
        b.status = "finished"
    except Exception as e:
        log.exception("battle %s failed", b.id)
        b.status = "error"
        b.emit({"type": "error", "message": str(e)})
    b.emit({"type": "battle_finished", "status": b.status, "results": b.results})


async def _run_lane(b: Battle, lane: str) -> None:
    s = get_settings()
    async with pool.context(sandboxed=True) as ctx:
        page = await ctx.new_page()
        await page.goto(sandbox_url(b.sandbox_id))
        b.emit({"type": "page_loaded", "lane": lane, "screenshot": await screenshot_b64(page)})

        findings, fixes = [], []
        if lane == "protected":
            report = await detect(page)
            findings = report["findings"]
            fixes = await sanitize(page, findings)
            b.emit({
                "type": "sanitized", "lane": lane, "findings": findings, "fixes": fixes,
                "risk_score": risk_score(findings), "screenshot": await screenshot_b64(page),
            })

        receipt = None
        guarded_url = page.url
        for step in range(1, s.agent_max_steps + 1):
            obs = await agent.observe(page)
            if obs["receipt"]:
                receipt = obs["receipt"]
                break
            if lane == "protected" and page.url != guarded_url:
                # New page in a multi-step flow: guard it too.
                more = (await detect(page))["findings"]
                fixes += await sanitize(page, more)
                findings += more
                guarded_url = page.url
                obs = await agent.observe(page)
            decision = await agent.decide(b.goal, obs)
            if decision["action"] == "done":
                break
            await asyncio.sleep(s.step_delay_ms / 1000)
            try:
                await agent.act(page, decision)
            except Exception as e:
                decision["error"] = str(e).splitlines()[0]
            b.emit({"type": "step", "lane": lane, "step": step, "decision": decision,
                    "screenshot": await screenshot_b64(page)})
        else:
            obs = await agent.observe(page)
            receipt = obs["receipt"]

        b.results[lane] = {
            "receipt": receipt,
            "manipulated": receipt is None or not receipt["goal_met"],
            "findings_count": len(findings),
            "fixes_count": len(fixes),
        }
        b.emit({"type": "lane_finished", "lane": lane, **b.results[lane]})
