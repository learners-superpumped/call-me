"""Claude CLI wrapper for inbound calls.

Spawns claude CLI as a subprocess, maintains session across turns.
"""
from __future__ import annotations

import asyncio
import json
import logging

log = logging.getLogger("callme.claude")


class ClaudeSessionManager:
    def __init__(
        self,
        workspace_dir: str,
        permission_mode: str = "plan",
        timeout_ms: int = 180000,
    ) -> None:
        self._workspace_dir = workspace_dir
        self._permission_mode = permission_mode
        self._timeout_ms = timeout_ms
        self._session_id: str | None = None
        self._disposed = False

    async def send_message(self, text: str) -> str:
        if self._disposed:
            raise RuntimeError("ClaudeSessionManager has been disposed")

        args = ["--print", "--output-format", "json", "--verbose"]
        if self._permission_mode:
            args.extend(["--permission-mode", self._permission_mode])
        if self._session_id:
            args.extend(["--resume", self._session_id])

        log.info(
            "Sending message (session=%s): %s...",
            self._session_id or "new",
            text[:80],
        )

        proc = await asyncio.create_subprocess_exec(
            "claude",
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._workspace_dir,
        )

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=text.encode()),
                timeout=self._timeout_ms / 1000,
            )
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError(f"Claude CLI timeout after {self._timeout_ms}ms")

        if stderr:
            log.debug("claude stderr: %s", stderr.decode()[:200])

        if proc.returncode and proc.returncode != 0:
            raise RuntimeError(
                f"Claude CLI exited with code {proc.returncode}: {stderr.decode()[:200]}"
            )

        stdout_str = stdout.decode()
        try:
            parsed = json.loads(stdout_str)
        except json.JSONDecodeError:
            if stdout_str.strip():
                return stdout_str.strip()
            raise RuntimeError(f"Failed to parse Claude response: {stdout_str[:200]}")

        # --verbose outputs a JSON array of events; find the "result" event
        if isinstance(parsed, list):
            result_obj = next(
                (item for item in parsed if isinstance(item, dict) and item.get("type") == "result"),
                None,
            )
            if result_obj is None:
                # Fallback: try last dict in the array
                result_obj = next(
                    (item for item in reversed(parsed) if isinstance(item, dict)),
                    {},
                )
        else:
            result_obj = parsed

        if not self._session_id and result_obj.get("session_id"):
            self._session_id = result_obj["session_id"]
            log.info("New session: %s", self._session_id)
        if result_obj.get("is_error"):
            raise RuntimeError(f"Claude error: {result_obj.get('result', '')}")
        return result_obj.get("result", "")

    def dispose(self) -> None:
        self._disposed = True
        self._session_id = None

    @property
    def session_id(self) -> str | None:
        return self._session_id
