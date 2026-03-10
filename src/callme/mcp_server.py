"""MCP Server: 4개 도구를 Claude Code에 노출.

stdio 기반 MCP 서버. daemon에 HTTP로 위임한다.
"""
from __future__ import annotations

import asyncio
import logging

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from .daemon_client import DaemonClient

log = logging.getLogger("callme.mcp")


class CallMeMCPServer:
    def __init__(self, project_root: str) -> None:
        self._daemon = DaemonClient(project_root)
        self._daemon_ready: asyncio.Task | None = None
        self._server = self._build_server()

    async def _ensure_daemon(self) -> None:
        if self._daemon_ready is None:
            self._daemon_ready = asyncio.create_task(
                self._connect_with_retry()
            )
        await self._daemon_ready

    async def _connect_with_retry(self, max_retries: int = 3, delay: float = 1.0) -> None:
        for attempt in range(1, max_retries + 1):
            try:
                await self._daemon.connect()
                return
            except Exception as e:
                log.warning("Connection attempt %d/%d failed: %s", attempt, max_retries, e)
                if attempt == max_retries:
                    raise
                await asyncio.sleep(delay)

    def _build_server(self) -> Server:
        server = Server("callme")

        @server.list_tools()
        async def list_tools() -> list[Tool]:
            return [
                Tool(
                    name="initiate_call",
                    description=(
                        "Start a phone call with the user. Use when you need voice input, "
                        "want to report completed work, or need real-time discussion."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "message": {
                                "type": "string",
                                "description": "What you want to say to the user. Be natural and conversational.",
                            },
                        },
                        "required": ["message"],
                    },
                ),
                Tool(
                    name="continue_call",
                    description="Continue an active call with a follow-up message.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "call_id": {"type": "string", "description": "The call ID from initiate_call"},
                            "message": {"type": "string", "description": "Your follow-up message"},
                        },
                        "required": ["call_id", "message"],
                    },
                ),
                Tool(
                    name="speak_to_user",
                    description=(
                        "Speak a message on an active call without waiting for a response. "
                        "Use this to acknowledge requests or provide status updates before "
                        "starting time-consuming operations."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "call_id": {"type": "string", "description": "The call ID from initiate_call"},
                            "message": {"type": "string", "description": "What to say to the user"},
                        },
                        "required": ["call_id", "message"],
                    },
                ),
                Tool(
                    name="end_call",
                    description="End an active call with a closing message.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "call_id": {"type": "string", "description": "The call ID from initiate_call"},
                            "message": {"type": "string", "description": "Your closing message (say goodbye!)"},
                        },
                        "required": ["call_id", "message"],
                    },
                ),
            ]

        @server.call_tool()
        async def call_tool(name: str, arguments: dict) -> list[TextContent]:
            try:
                await self._ensure_daemon()

                if name == "initiate_call":
                    result = await self._daemon.initiate_call(arguments["message"])
                    return [TextContent(
                        type="text",
                        text=(
                            f"Call initiated successfully.\n\n"
                            f"Call ID: {result['callId']}\n\n"
                            f"User's response:\n{result['response']}\n\n"
                            f"Use continue_call to ask follow-ups or end_call to hang up."
                        ),
                    )]

                if name == "continue_call":
                    response = await self._daemon.continue_call(
                        arguments["call_id"], arguments["message"]
                    )
                    return [TextContent(type="text", text=f"User's response:\n{response}")]

                if name == "speak_to_user":
                    await self._daemon.speak_only(arguments["call_id"], arguments["message"])
                    return [TextContent(
                        type="text",
                        text=f'Message spoken: "{arguments["message"]}"',
                    )]

                if name == "end_call":
                    result = await self._daemon.end_call(
                        arguments["call_id"], arguments["message"]
                    )
                    return [TextContent(
                        type="text",
                        text=f"Call ended. Duration: {result['durationSeconds']}s",
                    )]

                raise ValueError(f"Unknown tool: {name}")

            except Exception as e:
                return [TextContent(type="text", text=f"Error: {e}")]

        return server

    async def run(self) -> None:
        # Start daemon connection in background
        self._daemon_ready = asyncio.create_task(self._connect_with_retry())

        log.info("ClawOps CallMe MCP server ready")

        async with stdio_server() as (read_stream, write_stream):
            await self._server.run(
                read_stream,
                write_stream,
                self._server.create_initialization_options(),
            )

        await self._daemon.disconnect()


async def run_mcp_server(project_root: str) -> None:
    server = CallMeMCPServer(project_root)
    await server.run()
