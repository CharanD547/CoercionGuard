import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from examples.guard_client import run_if_allowed

POLICY = {"currency": "USD", "max_immediate_charge_minor": 4000,
          "allowed_recurring_intervals": [], "allowed_data_fields": ["email"]}
PROPOSAL = {"currency": "USD", "immediate_charge_minor": 4000,
            "recurring_interval": "none", "data_fields": ["email"]}
PATH = "/api/v1/guard/check"


def test_mcp_discovers_read_only_tool_and_matches_rest():
    headers = {"Accept": "application/json, text/event-stream"}
    cases = [
        ({"immediate_charge_minor": 4900}, "block", "over_budget"),
        ({}, "allow", "within_budget"),
        ({"immediate_charge_minor": 0, "recurring_interval": "monthly"}, "block", "recurrence_disallowed"),
        ({"data_fields": ["email", "location"]}, "block", "disclosure_disallowed"),
        ({"immediate_charge_minor": None}, "review_required", "charge_unknown"),
        ({"currency": "EUR"}, "review_required", "currency_mismatch"),
        ({"currency": None, "data_fields": ["location"]}, "block", "disclosure_disallowed"),
    ]
    with TestClient(app) as client:
        def request(method, params=None):
            body = {"jsonrpc": "2.0", "id": 1, "method": method}
            if params is not None:
                body["params"] = params
            return client.post("/mcp", json=body, headers=headers).raise_for_status().json()

        initialized = request("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "guard-test", "version": "1"},
        })
        headers["MCP-Protocol-Version"] = initialized["result"]["protocolVersion"]
        tools = request("tools/list")["result"]["tools"]
        assert [tool["name"] for tool in tools] == ["evaluate_action"]
        assert tools[0]["annotations"]["readOnlyHint"] is True
        for changes, decision, code in cases:
            payload = {"policy": POLICY, "proposal": {**PROPOSAL, **changes}}
            result = request("tools/call", {"name": "evaluate_action", "arguments": payload})["result"]
            assert not result.get("isError")
            actual = result["structuredContent"]
            assert actual["decision"] == decision
            assert code in {check["code"] for check in actual["checks"]}
            assert actual == client.post(PATH, json=payload).json()

        invalid = {"policy": POLICY, "proposal": {**PROPOSAL, "immediate_charge_minor": "4000"}}
        result = request("tools/call", {"name": "evaluate_action", "arguments": invalid})["result"]
        assert result["isError"]


@pytest.mark.parametrize("changes,decision,code", [
    ({}, "allow", "within_budget"),
    ({"immediate_charge_minor": 4900}, "block", "over_budget"),
    ({"recurring_interval": "monthly"}, "block", "recurrence_disallowed"),
    ({"data_fields": ["email", "location"]}, "block", "disclosure_disallowed"),
    ({"immediate_charge_minor": None}, "review_required", "charge_unknown"),
    ({"currency": "EUR"}, "review_required", "currency_mismatch"),
    ({"recurring_interval": None}, "review_required", "recurrence_unknown"),
    ({"data_fields": None}, "review_required", "disclosure_unknown"),
    ({"currency": None, "data_fields": ["location"]}, "block", "disclosure_disallowed"),
])
def test_guard_decisions(changes, decision, code):
    response = TestClient(app).post(PATH, json={"policy": POLICY, "proposal": {**PROPOSAL, **changes}})
    assert response.status_code == 200
    result = response.json()
    assert result["decision"] == decision
    assert code in {check["code"] for check in result["checks"]}


@pytest.mark.parametrize("proposal", [
    {**PROPOSAL, "immediate_charge_minor": "4000"},
    {**PROPOSAL, "immediate_charge_minor": -1},
    {**PROPOSAL, "self_authorized": True},
    {key: value for key, value in PROPOSAL.items() if key != "recurring_interval"},
])
def test_guard_rejects_malformed_proposal(proposal):
    assert TestClient(app).post(PATH, json={"policy": POLICY, "proposal": proposal}).status_code == 422


def test_demo_caller_executes_only_allowed_payload():
    executed = []
    client = TestClient(app)
    for charge, decision in [(4900, "block"), (None, "review_required"), (4000, "allow")]:
        result = run_if_allowed(client, POLICY, {**PROPOSAL, "immediate_charge_minor": charge}, executed.append)
        assert result["decision"] == decision
    assert executed == [PROPOSAL]

    def timeout(request):
        raise httpx.ReadTimeout("test timeout", request=request)

    with httpx.Client(base_url="http://test", transport=httpx.MockTransport(timeout)) as offline:
        assert run_if_allowed(offline, POLICY, PROPOSAL, executed.append)["decision"] == "review_required"
    assert executed == [PROPOSAL]
