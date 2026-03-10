"""OpenAI Realtime STT via WebSocket.

Uses the OpenAI Realtime Transcription API with server-side VAD.
Audio input: PCM16 24kHz mono.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging

import websockets
import websockets.exceptions

log = logging.getLogger("callme.stt")


class OpenAIRealtimeSTT:
    def __init__(
        self,
        api_key: str,
        model: str = "gpt-4o-transcribe",
        silence_duration_ms: int = 800,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._silence_duration_ms = silence_duration_ms

        self._ws: websockets.ClientConnection | None = None
        self._connected = False
        self._closed = False
        self._transcript_queue: asyncio.Queue[str] = asyncio.Queue()
        self._recv_task: asyncio.Task | None = None

        self._reconnect_attempts = 0
        self._max_reconnect_attempts = 5

    async def connect(self) -> None:
        self._closed = False
        self._reconnect_attempts = 0
        await self._do_connect()

    async def _do_connect(self) -> None:
        url = "wss://api.openai.com/v1/realtime?intent=transcription"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "OpenAI-Beta": "realtime=v1",
        }
        self._ws = await websockets.connect(url, additional_headers=headers)
        self._connected = True
        self._reconnect_attempts = 0
        log.info("STT WebSocket connected")

        # Configure transcription session
        await self._ws.send(json.dumps({
            "type": "transcription_session.update",
            "session": {
                "input_audio_format": "pcm16",
                "input_audio_transcription": {
                    "model": self._model,
                    "language": "ko",
                },
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": self._silence_duration_ms,
                },
            },
        }))

        self._recv_task = asyncio.create_task(self._recv_loop())

    async def _recv_loop(self) -> None:
        try:
            async for raw in self._ws:  # type: ignore[union-attr]
                event = json.loads(raw)
                self._handle_event(event)
        except websockets.exceptions.ConnectionClosed:
            log.warning("STT WebSocket closed")
            self._connected = False
            if not self._closed:
                await self._attempt_reconnect()
        except Exception:
            log.exception("STT recv loop error")
            self._connected = False

    def _handle_event(self, event: dict) -> None:
        match event.get("type"):
            case "transcription_session.created" | "transcription_session.updated":
                log.debug("STT session: %s", event["type"])
            case "conversation.item.input_audio_transcription.completed":
                transcript = event.get("transcript", "")
                if transcript:
                    log.info("Transcript: %s", transcript)
                    self._transcript_queue.put_nowait(transcript)
            case "input_audio_buffer.speech_started":
                log.debug("Speech started")
            case "input_audio_buffer.speech_stopped":
                log.debug("Speech stopped")
            case "error":
                log.error("STT error: %s", event.get("error"))

    async def _attempt_reconnect(self) -> None:
        if self._closed:
            return
        if self._reconnect_attempts >= self._max_reconnect_attempts:
            log.error("STT max reconnect attempts reached")
            return

        self._reconnect_attempts += 1
        delay = min(1.0 * (2 ** (self._reconnect_attempts - 1)), 30.0)
        log.info("STT reconnecting in %.1fs (attempt %d)", delay, self._reconnect_attempts)
        await asyncio.sleep(delay)

        if self._closed:
            return
        try:
            await self._do_connect()
            log.info("STT reconnected")
        except Exception:
            log.exception("STT reconnect failed")

    def send_audio(self, pcm16_24k: bytes) -> None:
        """Send PCM16 24kHz audio to STT."""
        if not self._connected or not self._ws:
            return
        payload = base64.b64encode(pcm16_24k).decode("ascii")
        try:
            self._ws.send_nowait(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": payload,
            }))
        except Exception:
            log.debug("Failed to send audio to STT")

    async def wait_for_transcript(self, timeout_ms: int = 30000) -> str:
        """Wait for the next completed transcript."""
        return await asyncio.wait_for(
            self._transcript_queue.get(),
            timeout=timeout_ms / 1000,
        )

    def close(self) -> None:
        self._closed = True
        if self._recv_task and not self._recv_task.done():
            self._recv_task.cancel()
        if self._ws:
            asyncio.ensure_future(self._ws.close())
            self._ws = None
        self._connected = False
