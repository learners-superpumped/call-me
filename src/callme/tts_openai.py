"""OpenAI TTS provider.

Outputs PCM16 24kHz mono audio.
"""
from __future__ import annotations

import logging
from typing import AsyncIterator

from openai import AsyncOpenAI

log = logging.getLogger("callme.tts")


class OpenAITTS:
    def __init__(
        self,
        api_key: str,
        voice: str = "onyx",
        model: str = "tts-1",
    ) -> None:
        self._client = AsyncOpenAI(api_key=api_key)
        self._voice = voice
        self._model = model
        log.info("TTS provider: OpenAI (%s, voice: %s)", model, voice)

    async def synthesize(self, text: str) -> bytes:
        """Generate full PCM16 24kHz audio buffer."""
        response = await self._client.audio.speech.create(
            model=self._model,
            voice=self._voice,  # type: ignore[arg-type]
            input=text,
            response_format="pcm",
            speed=1.0,
        )
        return response.read()

    async def synthesize_stream(self, text: str) -> AsyncIterator[bytes]:
        """Stream PCM16 24kHz audio chunks as they arrive."""
        async with self._client.audio.speech.with_streaming_response.create(
            model=self._model,
            voice=self._voice,  # type: ignore[arg-type]
            input=text,
            response_format="pcm",
            speed=1.0,
        ) as response:
            async for chunk in response.iter_bytes(chunk_size=4096):
                yield chunk
