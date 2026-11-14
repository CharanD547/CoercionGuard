"""Send the same proposed action to the guard and the local demo tool."""

import json
import sys

import httpx


def run_if_allowed(client, policy, proposal, execute):
    payload = json.dumps({"policy": policy, "proposal": proposal})
    try:
        response = client.post("/api/v1/guard/check", content=payload,
                               headers={"Content-Type": "application/json"})
        response.raise_for_status()
        result = response.json()
        decision = result["decision"]
        if decision not in {"allow", "block", "review_required"}:
            raise ValueError("Unexpected decision")
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return {"decision": "review_required", "checks": [], "error": "Guard unavailable"}
    if decision == "allow":
        execute(json.loads(payload)["proposal"])
    return result


def display_order_summary(proposal):
    print(f"Demo tool opened an order summary for {proposal['currency']} "
          f"{proposal['immediate_charge_minor'] / 100:.2f}.")


if __name__ == "__main__":
    base_url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8001"
    policy = {"currency": "USD", "max_immediate_charge_minor": 4000,
              "allowed_recurring_intervals": [], "allowed_data_fields": []}
    with httpx.Client(base_url=base_url, timeout=5) as client:
        for charge in (4900, 4000):
            proposal = {"currency": "USD", "immediate_charge_minor": charge,
                        "recurring_interval": "none", "data_fields": []}
            print(run_if_allowed(client, policy, proposal, display_order_summary))
