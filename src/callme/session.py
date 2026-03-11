"""CallMeSession: SDK Session 프로토콜 구현 + MCP 턴 기반 제어.

SDK는 자율 AI 에이전트를 위해 설계되었지만, CallMe는 Claude Code MCP 도구로
턴 기반 대화를 제어한다. 이 세션은 두 세계를 연결하는 브릿지다.

SDK Session Protocol:
  - start(call): 미디어 스트림 연결 시 호출
  - feed_audio(audio, timestamp): 전화 오디오(ulaw 8kHz) 수신
  - stop(): 통화 종료 시 호출

MCP Control API:
  - speak(text): TTS → ulaw → call.send_audio()
  - listen(timeout_ms): STT transcript 대기
  - speak_and_listen(text, timeout_ms): 말하고 응답 대기
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from clawops.agent._audio import pcm16_to_ulaw, resample_pcm16, ulaw_to_pcm16

from .stt_openai import OpenAIRealtimeSTT
from .tts_openai import OpenAITTS
from .recorder import AudioRecorder

if TYPE_CHECKING:
    from clawops.agent._session import CallSession

    from .config import Config

log = logging.getLogger("callme.session")

# ulaw 160 bytes = 20ms at 8kHz (SDK 표준 프레임 크기)
ULAW_CHUNK = 160
ULAW_SILENCE = b"\xff"


async def _send_ulaw_chunked(call: CallSession, ulaw: bytes) -> None:
    """ulaw 오디오를 160B(20ms) 청크로 분할하여 전송. SDK 파이프라인과 동일."""
    for off in range(0, len(ulaw), ULAW_CHUNK):
        chunk = ulaw[off : off + ULAW_CHUNK]
        if len(chunk) < ULAW_CHUNK:
            chunk = chunk + ULAW_SILENCE * (ULAW_CHUNK - len(chunk))
        await call.send_audio(chunk)


class CallMeSession:
    """SDK Session 구현 + 턴 기반 MCP 제어 API."""

    def __init__(self, config: Config) -> None:
        self._config = config
        self._current_call: CallSession | None = None
        self._stt: OpenAIRealtimeSTT | None = None
        self._tts = OpenAITTS(
            api_key=config.openai_api_key,
            voice=config.tts_voice,
            model=config.tts_model,
        )
        self._call_ready = asyncio.Event()
        self._call_ended = asyncio.Event()
        self._hung_up = False
        self._recorder: AudioRecorder | None = None

    # ── SDK Session Protocol ──────────────────────────────────────

    async def start(self, call: CallSession) -> None:
        """SDK가 미디어 스트림 연결 시 호출."""
        self._current_call = call
        self._hung_up = False
        self._call_ready.clear()
        self._call_ended.clear()

        self._stt = OpenAIRealtimeSTT(
            api_key=self._config.openai_api_key,
            model=self._config.stt_model,
            silence_duration_ms=self._config.stt_silence_duration_ms,
        )
        await self._stt.connect()
        self._call_ready.set()
        if self._config.recording_enabled:
            from .daemon_lifecycle import CALLME_DIR

            rec_path = self._config.recording_path or str(CALLME_DIR / "recordings")
            self._recorder = AudioRecorder(rec_path, call.call_id)
            self._recorder.start()
        log.info("CallMeSession started for call %s", call.call_id)

    async def feed_audio(self, audio: bytes, timestamp: int) -> None:
        """SDK가 전화 오디오(ulaw 8kHz)를 전달."""
        if not self._stt or self._hung_up:
            return
        # ulaw 8kHz → PCM16 8kHz → PCM16 24kHz (OpenAI STT 입력)
        pcm16_8k = ulaw_to_pcm16(audio)
        if self._recorder:
            self._recorder.write_inbound(pcm16_8k)
        pcm16_24k = resample_pcm16(pcm16_8k, from_rate=8000, to_rate=24000)
        await self._stt.send_audio(pcm16_24k)

    async def stop(self) -> None:
        """SDK가 통화 종료 시 호출."""
        self._hung_up = True
        if self._stt:
            self._stt.close()
            self._stt = None
        if self._recorder:
            self._recorder.stop()
            self._recorder = None
        self._call_ended.set()
        log.info("CallMeSession stopped")

    # ── MCP Control API ───────────────────────────────────────────

    async def wait_ready(self, timeout: float = 15.0) -> None:
        """미디어 스트림 연결 대기."""
        await asyncio.wait_for(self._call_ready.wait(), timeout=timeout)

    async def speak(self, text: str) -> None:
        """TTS 생성 후 전화로 오디오 전송."""
        if not self._current_call or self._hung_up:
            return

        log.info("Speaking: %s", text[:80])

        pcm16_24k = await self._tts.synthesize(text)
        pcm16_8k = resample_pcm16(pcm16_24k, from_rate=24000, to_rate=8000)
        if self._recorder:
            self._recorder.write_outbound(pcm16_8k)
        ulaw = pcm16_to_ulaw(pcm16_8k)
        await _send_ulaw_chunked(self._current_call, ulaw)

    async def speak_streaming(self, text: str) -> None:
        """TTS 스트리밍으로 지연 최소화."""
        if not self._current_call or self._hung_up:
            return

        log.info("Speaking (streaming): %s", text[:80])

        buffer = bytearray()
        async for chunk in self._tts.synthesize_stream(text):
            if self._hung_up:
                break
            buffer.extend(chunk)
            # 충분한 데이터가 쌓이면 변환 후 160B 청크로 전송
            while len(buffer) >= 960:
                pcm_chunk = bytes(buffer[:960])
                del buffer[:960]
                pcm16_8k = resample_pcm16(pcm_chunk, from_rate=24000, to_rate=8000)
                if self._recorder:
                    self._recorder.write_outbound(pcm16_8k)
                ulaw = pcm16_to_ulaw(pcm16_8k)
                await _send_ulaw_chunked(self._current_call, ulaw)

        # 남은 버퍼 처리
        if buffer and not self._hung_up:
            pcm16_8k = resample_pcm16(bytes(buffer), from_rate=24000, to_rate=8000)
            if self._recorder:
                self._recorder.write_outbound(pcm16_8k)
            ulaw = pcm16_to_ulaw(pcm16_8k)
            await _send_ulaw_chunked(self._current_call, ulaw)

    async def listen(self, timeout_ms: int | None = None) -> str:
        """사용자 음성 STT 결과 대기."""
        if not self._stt:
            raise RuntimeError("STT session not initialized")

        timeout = timeout_ms or self._config.transcript_timeout_ms

        # 행업과 transcript를 경쟁
        transcript_task = asyncio.create_task(
            self._stt.wait_for_transcript(timeout_ms=timeout)
        )
        ended_task = asyncio.create_task(self._call_ended.wait())

        done, pending = await asyncio.wait(
            [transcript_task, ended_task],
            return_when=asyncio.FIRST_COMPLETED,
        )

        for task in pending:
            task.cancel()

        if transcript_task in done:
            return transcript_task.result()

        raise RuntimeError("Call ended before receiving transcript")

    async def speak_and_listen(self, text: str, timeout_ms: int | None = None) -> str:
        """TTS로 말한 후 사용자 응답 대기."""
        await self.speak_streaming(text)
        return await self.listen(timeout_ms)

    @property
    def is_hung_up(self) -> bool:
        return self._hung_up

    @property
    def current_call(self) -> CallSession | None:
        return self._current_call

    def reset(self) -> None:
        """다음 통화를 위해 상태 초기화."""
        if self._recorder:
            self._recorder.stop()
            self._recorder = None
        self._current_call = None
        self._hung_up = False
        self._call_ready.clear()
        self._call_ended.clear()
        if self._stt:
            self._stt.close()
            self._stt = None
