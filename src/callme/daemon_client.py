"""Daemon HTTP client for MCP server → daemon communication."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import aiohttp

from .daemon_lifecycle import ensure_daemon_running

log = logging.getLogger("callme.client")


class DaemonClient:
    def __init__(self, project_root: str) -> None:
        self._project_root = project_root
        self._control_port = 0
        self._client_id = ""
        self._heartbeat_task: asyncio.Task | None = None
        self._session: aiohttp.ClientSession | None = None

    async def connect(self) -> None:
        self._control_port = await ensure_daemon_running(self._project_root)
        self._session = aiohttp.ClientSession()

        data = await self._post("/connect", {})
        self._client_id = data["clientId"]
        log.info("Connected to daemon as %s", self._client_id)

        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def disconnect(self) -> None:
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None
        try:
            await self._post("/disconnect", {"clientId": self._client_id})
        except Exception:
            pass
        if self._session:
            await self._session.close()
            self._session = None

    async def initiate_call(
        self, message: str, to: str | None = None
    ) -> dict[str, str]:
        body: dict[str, str] = {"clientId": self._client_id, "message": message}
        if to:
            body["to"] = to
        return await self._post("/calls", body, timeout=300)

    async def continue_call(self, call_id: str, message: str) -> str:
        data = await self._post(
            f"/calls/{call_id}/continue",
            {"clientId": self._client_id, "message": message},
            timeout=300,
        )
        return data["response"]

    async def speak_only(self, call_id: str, message: str) -> None:
        await self._post(
            f"/calls/{call_id}/speak",
            {"clientId": self._client_id, "message": message},
            timeout=60,
        )

    async def end_call(self, call_id: str, message: str) -> dict[str, Any]:
        return await self._post(
            f"/calls/{call_id}/end",
            {"clientId": self._client_id, "message": message},
            timeout=60,
        )

    async def _post(
        self, path: str, body: dict, timeout: int = 10
    ) -> dict[str, Any]:
        if not self._session:
            raise RuntimeError("Not connected to daemon")
        url = f"http://127.0.0.1:{self._control_port}{path}"
        async with self._session.post(
            url,
            json=body,
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as resp:
            data = await resp.json(content_type=None)
            if resp.status == 409:
                raise RuntimeError(data.get("error", "Conflict"))
            if resp.status == 403:
                raise RuntimeError(data.get("error", "Forbidden"))
            if not resp.ok:
                raise RuntimeError(data.get("error", f"Daemon error: {resp.status}"))
            return data

    async def _heartbeat_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(5)
                try:
                    await self._post("/heartbeat", {"clientId": self._client_id})
                except Exception:
                    log.warning("Heartbeat failed")
        except asyncio.CancelledError:
            pass
