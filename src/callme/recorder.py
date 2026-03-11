"""AudioRecorder: per-call 실시간 양방향 녹음 + mix.

3개 WAV 파일을 wall-clock 동기화로 실시간 기록:
- {call_id}/in.wav   — 발신자 음성 (수신, PCM16 8kHz mono)
- {call_id}/out.wav  — AI 음성 (송신, PCM16 8kHz mono)
- {call_id}/mix.wav  — 양쪽 합성 (PCM16 8kHz mono)
"""
from __future__ import annotations

import logging
import struct
import time
from pathlib import Path

log = logging.getLogger("callme.recorder")

WAV_SAMPLE_RATE = 8000
WAV_CHANNELS = 1
WAV_BITS_PER_SAMPLE = 16
WAV_HEADER_SIZE = 44
BYTES_PER_SECOND = WAV_SAMPLE_RATE * WAV_CHANNELS * WAV_BITS_PER_SAMPLE // 8


def _wav_header(data_size: int = 0) -> bytes:
    """PCM16 8kHz mono WAV 헤더 생성."""
    byte_rate = WAV_SAMPLE_RATE * WAV_CHANNELS * WAV_BITS_PER_SAMPLE // 8
    block_align = WAV_CHANNELS * WAV_BITS_PER_SAMPLE // 8
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM
        WAV_CHANNELS,
        WAV_SAMPLE_RATE,
        byte_rate,
        block_align,
        WAV_BITS_PER_SAMPLE,
        b"data",
        data_size,
    )


def _mix_samples(existing: bytes, new: bytes) -> bytes:
    """두 PCM16 버퍼를 샘플 단위로 합산 (clipping 방지)."""
    n = min(len(existing), len(new)) // 2
    fmt = f"<{n}h"
    a = struct.unpack(fmt, existing[: n * 2])
    b = struct.unpack(fmt, new[: n * 2])
    mixed = [max(-32768, min(32767, x + y)) for x, y in zip(a, b)]
    return struct.pack(fmt, *mixed)


class AudioRecorder:
    """실시간 양방향 녹음기 + mix."""

    def __init__(self, path: str | Path, call_id: str) -> None:
        self._dir = Path(path) / call_id
        self._call_id = call_id
        self._in_file = None
        self._out_file = None
        self._mix_file = None
        self._in_written = 0
        self._out_written = 0
        self._mix_written = 0
        self._start_time = 0.0
        self._started = False

    def start(self) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)

        self._in_file = open(self._dir / "in.wav", "w+b")
        self._out_file = open(self._dir / "out.wav", "w+b")
        self._mix_file = open(self._dir / "mix.wav", "w+b")

        for f in (self._in_file, self._out_file, self._mix_file):
            f.write(_wav_header(0))

        self._in_written = 0
        self._out_written = 0
        self._mix_written = 0
        self._start_time = time.monotonic()
        self._started = True
        log.info("Recording started: %s", self._dir)

    def _expected_bytes(self) -> int:
        """Wall-clock 기준 현재까지 기록되어야 할 바이트 수."""
        elapsed = time.monotonic() - self._start_time
        return int(elapsed * BYTES_PER_SECOND)

    def _pad_silence(self, file, written: int, expected: int) -> int:
        """트랙 파일에 무음 패딩 삽입. 삽입된 바이트 수 반환."""
        gap = expected - written
        if gap <= 0:
            return 0
        # 2바이트 정렬
        gap = gap - (gap % 2)
        if gap > 0:
            file.write(b"\x00" * gap)
        return gap

    def _write_to_mix(self, pcm16: bytes, track_written_before: int) -> None:
        """mix 파일에 데이터 기록. 겹침 구간은 샘플 합산."""
        data_offset = track_written_before  # 이 데이터의 타임라인 바이트 위치

        if data_offset < self._mix_written:
            # 겹침: mix에 이미 데이터가 있는 구간
            overlap_start = data_offset
            overlap_end = min(data_offset + len(pcm16), self._mix_written)
            overlap_len = overlap_end - overlap_start

            if overlap_len > 0:
                # 기존 mix 데이터 읽기
                self._mix_file.seek(WAV_HEADER_SIZE + overlap_start)
                existing = self._mix_file.read(overlap_len)
                mixed = _mix_samples(existing, pcm16[:overlap_len])
                self._mix_file.seek(WAV_HEADER_SIZE + overlap_start)
                self._mix_file.write(mixed)

            # 겹침 이후 남은 데이터 append
            remaining = pcm16[overlap_len:]
            if remaining:
                self._mix_file.seek(WAV_HEADER_SIZE + self._mix_written)
                self._mix_file.write(remaining)
                self._mix_written += len(remaining)
        else:
            # 겹침 없음: gap 패딩 후 append
            gap = data_offset - self._mix_written
            if gap > 0:
                gap = gap - (gap % 2)
                self._mix_file.seek(WAV_HEADER_SIZE + self._mix_written)
                self._mix_file.write(b"\x00" * gap)
                self._mix_written += gap

            self._mix_file.seek(WAV_HEADER_SIZE + self._mix_written)
            self._mix_file.write(pcm16)
            self._mix_written += len(pcm16)

    def write_inbound(self, pcm16: bytes) -> None:
        """수신 오디오 기록 (PCM16 8kHz)."""
        if not self._started:
            return
        try:
            expected = self._expected_bytes()
            gap = self._pad_silence(self._in_file, self._in_written, expected)
            self._in_written += gap

            before = self._in_written
            self._in_file.write(pcm16)
            self._in_written += len(pcm16)

            self._write_to_mix(pcm16, before)
        except Exception:
            log.exception("Recording write_inbound error")

    def write_outbound(self, pcm16: bytes) -> None:
        """송신 오디오 기록 (PCM16 8kHz)."""
        if not self._started:
            return
        try:
            expected = self._expected_bytes()
            gap = self._pad_silence(self._out_file, self._out_written, expected)
            self._out_written += gap

            before = self._out_written
            self._out_file.write(pcm16)
            self._out_written += len(pcm16)

            self._write_to_mix(pcm16, before)
        except Exception:
            log.exception("Recording write_outbound error")

    def stop(self) -> None:
        """녹음 종료. WAV 헤더를 최종 크기로 업데이트."""
        if not self._started:
            return
        self._started = False

        try:
            # 최종 길이 동기화: 가장 긴 트랙에 맞춤
            max_len = max(self._in_written, self._out_written, self._mix_written)
            # 2바이트 정렬
            max_len = max_len - (max_len % 2)

            for f, written in [
                (self._in_file, self._in_written),
                (self._out_file, self._out_written),
                (self._mix_file, self._mix_written),
            ]:
                if f and not f.closed:
                    pad = max_len - written
                    if pad > 0:
                        f.seek(WAV_HEADER_SIZE + written)
                        f.write(b"\x00" * pad)
                    f.seek(0)
                    f.write(_wav_header(max_len))
                    f.close()
        except Exception:
            log.exception("Recording stop error")

        log.info(
            "Recording stopped: %s (in=%dB out=%dB mix=%dB)",
            self._call_id,
            self._in_written,
            self._out_written,
            self._mix_written,
        )
