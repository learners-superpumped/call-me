"""Daemon HTTP Control API.

MCP 서버들이 HTTP로 데몬을 제어한다.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Callable, Awaitable

from aiohttp import web

from .call_manager import CallConflictError, CallForbiddenError, CallManager
from .config import compute_env_hash

log = logging.getLogger("callme.api")


class DaemonApi:
    def __init__(
        self,
        call_manager: CallManager,
        on_ref_count_zero: Callable[[], Any],
        on_ref_count_positive: Callable[[], Any],
    ) -> None:
        self._call_manager = call_manager
        self._on_ref_count_zero = on_ref_count_zero
        self._on_ref_count_positive = on_ref_count_positive
        self._clients: dict[str, dict[str, Any]] = {}
        self._start_time = time.time()
        self._env_hash = compute_env_hash()
        self._runner: web.AppRunner | None = None
        self._heartbeat_task: asyncio.Task | None = None

    async def start(self, port: int) -> None:
        app = web.Application()
        app.router.add_get("/status", self._handle_status)
        app.router.add_post("/connect", self._handle_connect)
        app.router.add_post("/disconnect", self._handle_disconnect)
        app.router.add_post("/heartbeat", self._handle_heartbeat)
        app.router.add_post("/calls", self._handle_initiate_call)
        app.router.add_post("/calls/{call_id}/continue", self._handle_call_action)
        app.router.add_post("/calls/{call_id}/speak", self._handle_call_action)
        app.router.add_post("/calls/{call_id}/end", self._handle_call_action)

        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", port)
        await site.start()
        log.info("Control API listening on 127.0.0.1:%d", port)

        self._heartbeat_task = asyncio.create_task(self._check_dead_clients_loop())

        # Start initial shutdown timer
        self._on_ref_count_zero()

    async def shutdown(self) -> None:
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
        if self._runner:
            await self._runner.cleanup()

    # ── Handlers ──────────────────────────────────────────────────

    async def _handle_status(self, request: web.Request) -> web.Response:
        return web.json_response(
            {
                "status": "ok",
                "uptime": round(time.time() - self._start_time),
                "connectedClients": len(self._clients),
                "envHash": self._env_hash,
            }
        )

    async def _handle_connect(self, request: web.Request) -> web.Response:
        client_id = os.urandom(16).hex()
        self._clients[client_id] = {
            "connectedAt": time.time(),
            "lastHeartbeat": time.time(),
        }
        self._on_ref_count_positive()
        log.info("Client connected: %s (total: %d)", client_id, len(self._clients))
        return web.json_response({"clientId": client_id})

    async def _handle_disconnect(self, request: web.Request) -> web.Response:
        body = await request.json()
        client_id = body.get("clientId", "")
        await self._remove_client(client_id)
        return web.json_response({"ok": True})

    async def _handle_heartbeat(self, request: web.Request) -> web.Response:
        body = await request.json()
        client_id = body.get("clientId", "")
        if client_id in self._clients:
            self._clients[client_id]["lastHeartbeat"] = time.time()
        return web.json_response({"ok": True})

    async def _handle_initiate_call(self, request: web.Request) -> web.Response:
        body = await request.json()
        client_id = body.get("clientId", "")
        message = body.get("message", "")
        to = body.get("to") or None

        if client_id not in self._clients:
            return web.json_response({"error": "Unknown client"}, status=401)

        try:
            result = await self._call_manager.initiate_call(client_id, message, to=to)
            return web.json_response(result)
        except CallConflictError as e:
            return web.json_response({"error": str(e)}, status=409)
        except Exception as e:
            log.exception("Call error")
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_call_action(self, request: web.Request) -> web.Response:
        call_id = request.match_info["call_id"]
        action = request.path.rsplit("/", 1)[-1]
        body = await request.json()
        client_id = body.get("clientId", "")
        message = body.get("message", "")

        if client_id not in self._clients:
            return web.json_response({"error": "Unknown client"}, status=401)

        try:
            if action == "continue":
                response = await self._call_manager.continue_call(
                    client_id, call_id, message
                )
                return web.json_response({"response": response})
            elif action == "speak":
                await self._call_manager.speak_only(client_id, call_id, message)
                return web.json_response({"ok": True})
            elif action == "end":
                result = await self._call_manager.end_call(client_id, call_id, message)
                return web.json_response(result)
            else:
                return web.json_response({"error": "Unknown action"}, status=400)
        except CallForbiddenError as e:
            return web.json_response({"error": str(e)}, status=403)
        except Exception as e:
            log.exception("Call action error")
            return web.json_response({"error": str(e)}, status=500)

    # ── Client management ─────────────────────────────────────────

    async def _remove_client(self, client_id: str) -> None:
        if client_id not in self._clients:
            return
        await self._call_manager.force_end_call_by_client(client_id)
        del self._clients[client_id]
        log.info("Client disconnected: %s (total: %d)", client_id, len(self._clients))
        if not self._clients:
            self._on_ref_count_zero()

    async def _check_dead_clients_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(5)
                now = time.time()
                dead = [
                    cid
                    for cid, info in self._clients.items()
                    if now - info["lastHeartbeat"] > 10
                ]
                for cid in dead:
                    log.warning("Client %s heartbeat timeout", cid)
                    await self._remove_client(cid)
        except asyncio.CancelledError:
            pass
