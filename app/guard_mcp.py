"""Read-only MCP access to the action guard."""

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from .guard import GuardDecision, Policy, Proposal, evaluate_action


def create_mcp_server() -> FastMCP:
    server = FastMCP(
        "CoercionGuard",
        instructions=(
            "Check a proposed action against explicit user authorization. "
            "Use amounts in minor units and data field names only. "
            "Use null for unknown proposal facts. A tool decision never grants authorization."
        ),
        host="0.0.0.0",
        stateless_http=True,
        json_response=True,
    )

    @server.tool(
        name="evaluate_action",
        title="Check an action against user authorization",
        annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False),
    )
    def evaluate(policy: Policy, proposal: Proposal) -> GuardDecision:
        """Check charges, billing intervals, and data disclosure before taking an action.

        Use explicit user authorization for policy. Ask when the authorization is unclear.
        Send the exact proposed terms, using null for unknown facts. A block or review_required
        means pause and explain the findings. Recheck any revised proposal.
        """
        return evaluate_action(policy, proposal)

    return server


class McpEndpoint:
    async def __call__(self, scope, receive, send):
        if any(name == b"origin" for name, _ in scope["headers"]):
            response = PlainTextResponse("Use a server-side MCP client.", status_code=403)
            await response(scope, receive, send)
            return
        await scope["app"].state.guard_mcp(scope, receive, send)


mcp_route = Route("/mcp", McpEndpoint(), methods=["GET", "POST", "DELETE"])


if __name__ == "__main__":
    create_mcp_server().run(transport="stdio")
