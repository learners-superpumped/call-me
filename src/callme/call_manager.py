"""CallManager: ClawOps SDK 기반 콜 관리.

SDK의 ClawOpsAgent를 사용하여 인바운드/아웃바운드 전화를 처리한다.
ngrok, webhook, WS 서버가 전부 제거되고 SDK의 reverse WebSocket으로 대체된다.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from clawops.agent import ClawOpsAgent

from .claude_session import ClaudeSessionManager
from .config import Config
from .session import CallMeSession

log = logging.getLogger("callme.manager")


class CallConflictError(Exception):
    pass


class CallForbiddenError(Exception):
    pass


@dataclass
class OutboundCallState:
    call_id: str
    owner_client_id: str
    start_time: float = field(default_factory=time.time)
    conversation_history: list[dict[str, str]] = field(default_factory=list)


@dataclass
class InboundCallState:
    call_id: str
    from_number: str
    start_time: float = field(default_factory=time.time)
    claude_session: ClaudeSessionManager | None = None
    conversation_history: list[dict[str, str]] = field(default_factory=list)


class CallManager:
    def __init__(self, config: Config) -> None:
        self._config = config
        self._session = CallMeSession(config)
        self._agent = ClawOpsAgent(
            from_=config.phone_number,
            session=self._session,
            api_key=config.api_key,
            account_id=config.account_id,
            base_url=config.base_url,
        )

        self._outbound_calls: dict[str, OutboundCallState] = {}
        self._inbound_calls: dict[str, InboundCallState] = {}
        self._inbound_tasks: dict[str, asyncio.Task] = {}

    async def start(self) -> None:
        """SDK Agent 연결 (persistent Control WebSocket)."""
        # 이벤트 핸들러 등록
        @self._agent.on("call_start")
        async def on_call_start(call: Any) -> None:
            if call.direction == "inbound":
                await self._handle_inbound_call(call)

        @self._agent.on("call_end")
        async def on_call_end(call: Any) -> None:
            call_id = call.call_id
            if call_id in self._outbound_calls:
                self._session.reset()
                self._outbound_calls.pop(call_id, None)
                log.info("Outbound call ended: %s", call_id)
            elif call_id in self._inbound_calls:
                state = self._inbound_calls.pop(call_id, None)
                if state and state.claude_session:
                    state.claude_session.dispose()
                task = self._inbound_tasks.pop(call_id, None)
                if task and not task.done():
                    task.cancel()
                log.info("Inbound call ended: %s", call_id)

        await self._agent.connect()
        log.info("CallManager started (SDK Agent connected)")

        if self._config.unsafe_no_number_restriction:
            log.warning(
                "⚠ CALLME_UNSAFE_NO_NUMBER_RESTRICTION is ON – "
                "inbound/outbound number restrictions are DISABLED. "
                "The operator assumes full responsibility for any charges, "
                "abuse, or regulatory issues."
            )

    async def stop(self) -> None:
        """SDK Agent 연결 해제."""
        # 활성 통화 정리
        for call_id in list(self._inbound_tasks.keys()):
            task = self._inbound_tasks.pop(call_id)
            task.cancel()
        for state in self._inbound_calls.values():
            if state.claude_session:
                state.claude_session.dispose()
        self._inbound_calls.clear()
        self._outbound_calls.clear()
        await self._agent.disconnect()
        log.info("CallManager stopped")

    def _get_total_active_calls(self) -> int:
        return len(self._outbound_calls) + len(self._inbound_calls)

    # ── Outbound (MCP 도구에서 호출) ─────────────────────────────

    async def initiate_call(
        self, client_id: str, message: str, to: str | None = None
    ) -> dict[str, str]:
        if self._get_total_active_calls() > 0:
            raise CallConflictError("A call is already in progress")

        dest = self._config.user_phone_number
        if to:
            if not self._config.unsafe_no_number_restriction:
                raise CallForbiddenError(
                    "Custom destination number requires "
                    "CALLME_UNSAFE_NO_NUMBER_RESTRICTION=true"
                )
            dest = to

        self._session.reset()

        log.info("Initiating outbound call to %s", dest)
        call = await self._agent.call(to=dest)

        # 미디어 스트림 연결 대기
        await self._session.wait_ready(timeout=30.0)

        state = OutboundCallState(
            call_id=call.call_id,
            owner_client_id=client_id,
        )
        self._outbound_calls[call.call_id] = state

        # 말하고 응답 대기
        response = await self._session.speak_and_listen(
            message, self._config.transcript_timeout_ms
        )
        state.conversation_history.append({"speaker": "claude", "message": message})
        state.conversation_history.append({"speaker": "user", "message": response})

        return {"callId": call.call_id, "response": response}

    async def continue_call(
        self, client_id: str, call_id: str, message: str
    ) -> str:
        state = self._outbound_calls.get(call_id)
        if not state:
            raise CallForbiddenError(f"Call {call_id} not found")
        if state.owner_client_id != client_id:
            raise CallForbiddenError("Not the call owner")

        response = await self._session.speak_and_listen(
            message, self._config.transcript_timeout_ms
        )
        state.conversation_history.append({"speaker": "claude", "message": message})
        state.conversation_history.append({"speaker": "user", "message": response})
        return response

    async def speak_only(
        self, client_id: str, call_id: str, message: str
    ) -> None:
        state = self._outbound_calls.get(call_id)
        if not state:
            raise CallForbiddenError(f"Call {call_id} not found")
        if state.owner_client_id != client_id:
            raise CallForbiddenError("Not the call owner")

        await self._session.speak_streaming(message)
        state.conversation_history.append({"speaker": "claude", "message": message})

    async def end_call(
        self, client_id: str, call_id: str, message: str
    ) -> dict[str, Any]:
        state = self._outbound_calls.get(call_id)
        if not state:
            raise CallForbiddenError(f"Call {call_id} not found")
        if state.owner_client_id != client_id:
            raise CallForbiddenError("Not the call owner")

        # 작별 인사
        await self._session.speak_streaming(message)

        duration = time.time() - state.start_time

        # 행업
        if self._session.current_call:
            await self._session.current_call.hangup()
        self._session.reset()
        self._outbound_calls.pop(call_id, None)

        return {"durationSeconds": round(duration)}

    async def force_end_call_by_client(self, client_id: str) -> None:
        """클라이언트 연결 해제 시 해당 클라이언트의 통화 강제 종료."""
        for call_id, state in list(self._outbound_calls.items()):
            if state.owner_client_id == client_id:
                log.info("Force-ending call %s (client disconnected)", call_id)
                if self._session.current_call:
                    await self._session.current_call.hangup()
                self._session.reset()
                self._outbound_calls.pop(call_id, None)

    # ── Inbound (SDK 이벤트에서 자동 처리) ────────────────────────

    def _is_whitelisted(self, phone_number: str) -> bool:
        whitelist = {self._config.user_phone_number, *self._config.inbound_whitelist}
        return phone_number in whitelist

    async def _handle_inbound_call(self, call: Any) -> None:
        if not self._config.inbound_enabled:
            log.info("Rejecting inbound call: disabled")
            await call.hangup()
            return

        from_number = call.from_number
        if not self._config.unsafe_no_number_restriction and not self._is_whitelisted(
            from_number
        ):
            log.info("Rejecting inbound call from %s: not whitelisted", from_number)
            await call.hangup()
            return

        if self._get_total_active_calls() >= self._config.inbound_max_calls:
            log.info("Rejecting inbound call: max calls reached")
            await call.hangup()
            return

        state = InboundCallState(
            call_id=call.call_id,
            from_number=from_number,
        )
        self._inbound_calls[call.call_id] = state

        task = asyncio.create_task(self._run_inbound_conversation(call, state))
        self._inbound_tasks[call.call_id] = task

    async def _run_inbound_conversation(
        self, call: Any, state: InboundCallState
    ) -> None:
        try:
            # 미디어 준비 대기
            await self._session.wait_ready(timeout=15.0)

            # 인사말 (Claude CLI 시작 시간 커버)
            greeting = self._config.inbound_greeting
            await self._session.speak_streaming(greeting)

            # Claude CLI 세션 시작
            claude = ClaudeSessionManager(
                workspace_dir=self._config.inbound_workspace_dir,
                permission_mode=self._config.inbound_permission_mode,
            )
            state.claude_session = claude

            # 대화 루프
            while not self._session.is_hung_up:
                try:
                    user_text = await self._session.listen(
                        self._config.transcript_timeout_ms
                    )
                except (asyncio.TimeoutError, RuntimeError):
                    break

                state.conversation_history.append(
                    {"speaker": "caller", "message": user_text}
                )

                try:
                    claude_response = await claude.send_message(user_text)
                except Exception as e:
                    log.error("Claude CLI error: %s", e)
                    await self._session.speak_streaming(
                        "죄송합니다, 처리 중 오류가 발생했습니다."
                    )
                    continue

                state.conversation_history.append(
                    {"speaker": "claude", "message": claude_response}
                )
                await self._session.speak_streaming(claude_response)

        except asyncio.CancelledError:
            log.info("Inbound conversation cancelled: %s", state.call_id)
        except Exception:
            log.exception("Inbound conversation error: %s", state.call_id)
        finally:
            if state.claude_session:
                state.claude_session.dispose()
            self._session.reset()
            self._inbound_calls.pop(state.call_id, None)
            self._inbound_tasks.pop(state.call_id, None)
