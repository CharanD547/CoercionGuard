"""Deterministic checks for a caller's proposed action."""

from typing import Annotated, Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

router = APIRouter(tags=["Action guard"])

Currency = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]
Amount = Annotated[int, Field(ge=0, le=9_007_199_254_740_991)]
Interval = Literal["daily", "weekly", "monthly", "quarterly", "yearly"]
FieldName = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_.-]{0,63}$")]
DataFields = Annotated[list[FieldName], Field(max_length=64)]


class GuardModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Policy(GuardModel):
    currency: Currency
    max_immediate_charge_minor: Amount
    allowed_recurring_intervals: Annotated[list[Interval], Field(max_length=5)]
    allowed_data_fields: DataFields


class Proposal(GuardModel):
    currency: Currency | None
    immediate_charge_minor: Amount | None
    recurring_interval: Interval | Literal["none"] | None
    data_fields: DataFields | None


class GuardRequest(GuardModel):
    policy: Policy
    proposal: Proposal


class Finding(GuardModel):
    key: Literal["charge", "renewal", "data"]
    status: Literal["pass", "violation", "unknown"]
    code: Literal[
        "within_budget", "charge_unknown", "currency_unknown", "currency_mismatch",
        "over_budget", "recurrence_allowed", "recurrence_unknown", "recurrence_disallowed",
        "disclosure_allowed", "disclosure_unknown", "disclosure_disallowed",
    ]
    unauthorized_fields: list[FieldName] = Field(default_factory=list)


class GuardDecision(GuardModel):
    decision: Literal["allow", "block", "review_required"]
    checks: list[Finding]


@router.post("/api/v1/guard/check", response_model=GuardDecision)
async def check_action(body: GuardRequest, response: Response) -> GuardDecision:
    """Check authorized limits before executing the exact proposed action."""
    response.headers["Cache-Control"] = "no-store"
    policy, proposal = body.policy, body.proposal

    if proposal.immediate_charge_minor is None:
        charge = Finding(key="charge", status="unknown", code="charge_unknown")
    elif proposal.currency is None:
        charge = Finding(key="charge", status="unknown", code="currency_unknown")
    elif proposal.currency != policy.currency:
        charge = Finding(key="charge", status="unknown", code="currency_mismatch")
    elif proposal.immediate_charge_minor > policy.max_immediate_charge_minor:
        charge = Finding(key="charge", status="violation", code="over_budget")
    else:
        charge = Finding(key="charge", status="pass", code="within_budget")

    interval = proposal.recurring_interval
    if interval is None:
        renewal = Finding(key="renewal", status="unknown", code="recurrence_unknown")
    elif interval == "none" or interval in policy.allowed_recurring_intervals:
        renewal = Finding(key="renewal", status="pass", code="recurrence_allowed")
    else:
        renewal = Finding(key="renewal", status="violation", code="recurrence_disallowed")

    if proposal.data_fields is None:
        disclosure = Finding(key="data", status="unknown", code="disclosure_unknown")
    else:
        unauthorized = sorted(set(proposal.data_fields) - set(policy.allowed_data_fields))
        if unauthorized:
            disclosure = Finding(key="data", status="violation", code="disclosure_disallowed",
                                 unauthorized_fields=unauthorized)
        else:
            disclosure = Finding(key="data", status="pass", code="disclosure_allowed")

    checks = [charge, renewal, disclosure]
    statuses = {item.status for item in checks}
    if "violation" in statuses:
        return GuardDecision(decision="block", checks=checks)
    if "unknown" in statuses:
        return GuardDecision(decision="review_required", checks=checks)
    return GuardDecision(decision="allow", checks=checks)
