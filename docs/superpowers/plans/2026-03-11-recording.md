# Recording Feature Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add wall-clock synchronized 3-file (in/out/mix) WAV recording to clawops-call-me calls.

**Architecture:** New `AudioRecorder` class in `src/callme/recorder.py` handles real-time WAV writing with wall-clock silence padding and sample-level mix. Integrates into existing `CallMeSession` at audio input/output boundaries. Config adds two env vars.

**Tech Stack:** Python 3.11+, struct (PCM16 byte manipulation), time.monotonic (wall-clock), pytest

**Spec:** `docs/superpowers/specs/2026-03-11-recording-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/callme/recorder.py` | Create | AudioRecorder class — WAV header, wall-clock sync, 3-file write, mix overlap |
| `src/callme/config.py` | Modify | Add `recording_enabled`, `recording_path` fields |
| `src/callme/session.py` | Modify | Inject recorder into audio pipeline |
| `tests/test_recorder.py` | Create | Unit tests for AudioRecorder |

---

## Chunk 1: AudioRecorder Core + Tests

### Task 1: Config changes

**Files:**
- Modify: `src/callme/config.py`

- [ ] **Step 1: Add recording fields to Config dataclass**

In `src/callme/config.py`, add after the `inbound_greeting` field (line 47):

```python
    # Recording
    recording_enabled: bool = True
    recording_path: str = ""
```

- [ ] **Step 2: Add env var loading in load_config()**

In `src/callme/config.py`, add before the closing `)` of `Config(` in `load_config()` (after line 87):

```python
        recording_enabled=os.environ.get(
            "CALLME_RECORDING_ENABLED", "true"
        ).lower()
        in ("true", "1", "yes"),
        recording_path=os.environ.get("CALLME_RECORDING_PATH", ""),
```

- [ ] **Step 3: Commit**

```bash
git add src/callme/config.py
git commit -m "feat(recording): add recording config fields"
```

### Task 2: WAV header and AudioRecorder skeleton

**Files:**
- Create: `src/callme/recorder.py`
- Create: `tests/test_recorder.py`

- [ ] **Step 1: Write failing test for WAV header**

Create `tests/test_recorder.py`:

```python
"""Tests for AudioRecorder."""

import struct
from pathlib import Path

from callme.recorder import WAV_HEADER_SIZE, AudioRecorder, _wav_header


def test_wav_header_format():
    """WAV header has correct RIFF structure and PCM16 8kHz mono format."""
    header = _wav_header(1000)
    assert len(header) == WAV_HEADER_SIZE

    # RIFF chunk
    assert header[:4] == b"RIFF"
    file_size = struct.unpack_from("<I", header, 4)[0]
    assert file_size == 36 + 1000  # header - 8 + data

    # WAVE + fmt
    assert header[8:12] == b"WAVE"
    assert header[12:16] == b"fmt "
    fmt_size, audio_fmt, channels, sample_rate = struct.unpack_from("<IHHI", header, 16)
    assert fmt_size == 16
    assert audio_fmt == 1  # PCM
    assert channels == 1
    assert sample_rate == 8000

    # data chunk
    assert header[36:40] == b"data"
    data_size = struct.unpack_from("<I", header, 40)[0]
    assert data_size == 1000
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/ghyeok/Developments/clawops-call-me && uv run pytest tests/test_recorder.py::test_wav_header_format -v`
Expected: FAIL (module not found)

- [ ] **Step 3: Write recorder.py with WAV header + AudioRecorder skeleton**

Create `src/callme/recorder.py`:

```python
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
```

- [ ] **Step 4: Run WAV header test to verify it passes**

Run: `cd /Users/ghyeok/Developments/clawops-call-me && uv run pytest tests/test_recorder.py::test_wav_header_format -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/callme/recorder.py tests/test_recorder.py
git commit -m "feat(recording): add AudioRecorder with WAV header"
```

### Task 3: AudioRecorder unit tests — inbound only, outbound only, start/stop

**Files:**
- Modify: `tests/test_recorder.py`

- [ ] **Step 1: Write tests for basic start/stop and single-track recording**

Append to `tests/test_recorder.py`:

```python
import wave


def test_start_creates_three_wav_files(tmp_path):
    """start() creates in.wav, out.wav, mix.wav with valid WAV headers."""
    rec = AudioRecorder(tmp_path, "test_call")
    rec.start()
    rec.stop()

    for name in ("in.wav", "out.wav", "mix.wav"):
        f = tmp_path / "test_call" / name
        assert f.exists()
        with wave.open(str(f), "rb") as w:
            assert w.getnchannels() == 1
            assert w.getsampwidth() == 2
            assert w.getframerate() == 8000


def test_write_inbound_only(tmp_path):
    """Inbound-only recording produces valid WAV with correct data size."""
    rec = AudioRecorder(tmp_path, "call_in")
    rec.start()

    # 160 samples = 320 bytes PCM16 (20ms at 8kHz)
    pcm16 = b"\x01\x00" * 160
    rec.write_inbound(pcm16)
    rec.write_inbound(pcm16)
    rec.stop()

    with wave.open(str(tmp_path / "call_in" / "in.wav"), "rb") as w:
        frames = w.readframes(w.getnframes())
        # At least 640 bytes of actual audio data
        assert len(frames) >= 640


def test_write_outbound_only(tmp_path):
    """Outbound-only recording produces valid WAV with correct data size."""
    rec = AudioRecorder(tmp_path, "call_out")
    rec.start()

    pcm16 = b"\x02\x00" * 160
    rec.write_outbound(pcm16)
    rec.stop()

    with wave.open(str(tmp_path / "call_out" / "out.wav"), "rb") as w:
        frames = w.readframes(w.getnframes())
        assert len(frames) >= 320


def test_stop_equalizes_track_lengths(tmp_path):
    """stop() pads all three files to the same length."""
    rec = AudioRecorder(tmp_path, "call_eq")
    rec.start()

    rec.write_inbound(b"\x01\x00" * 160)
    rec.write_inbound(b"\x01\x00" * 160)
    rec.write_outbound(b"\x02\x00" * 80)
    rec.stop()

    lengths = []
    for name in ("in.wav", "out.wav", "mix.wav"):
        with wave.open(str(tmp_path / "call_eq" / name), "rb") as w:
            lengths.append(w.getnframes())

    # All three files must have the same frame count
    assert lengths[0] == lengths[1] == lengths[2]


def test_write_before_start_is_noop():
    """Writing before start() does not raise."""
    rec = AudioRecorder("/tmp", "no_start")
    rec.write_inbound(b"\x00" * 320)
    rec.write_outbound(b"\x00" * 320)
    # No exception = pass
```

- [ ] **Step 2: Run all tests**

Run: `cd /Users/ghyeok/Developments/clawops-call-me && uv run pytest tests/test_recorder.py -v`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add tests/test_recorder.py
git commit -m "test(recording): add basic AudioRecorder unit tests"
```

### Task 4: Mix overlap and wall-clock gap tests

**Files:**
- Modify: `tests/test_recorder.py`

- [ ] **Step 1: Write mix and gap tests**

Append to `tests/test_recorder.py`:

```python
from callme.recorder import _mix_samples


def test_mix_samples_basic():
    """_mix_samples adds PCM16 samples correctly."""
    # Two samples: 100 and 200
    a = struct.pack("<2h", 100, 200)
    b = struct.pack("<2h", 50, -100)
    result = _mix_samples(a, b)
    mixed = struct.unpack("<2h", result)
    assert mixed == (150, 100)


def test_mix_samples_clipping():
    """_mix_samples clamps to int16 range."""
    a = struct.pack("<h", 32000)
    b = struct.pack("<h", 32000)
    result = _mix_samples(a, b)
    mixed = struct.unpack("<h", result)
    assert mixed[0] == 32767  # clamped

    a = struct.pack("<h", -32000)
    b = struct.pack("<h", -32000)
    result = _mix_samples(a, b)
    mixed = struct.unpack("<h", result)
    assert mixed[0] == -32768  # clamped


def test_mix_file_contains_both_tracks(tmp_path):
    """mix.wav contains data from both inbound and outbound."""
    rec = AudioRecorder(tmp_path, "call_mix")
    rec.start()

    # Write inbound and outbound simultaneously (same wall-clock moment)
    in_data = struct.pack("<4h", 1000, 2000, 3000, 4000)
    out_data = struct.pack("<4h", 500, 500, 500, 500)
    rec.write_inbound(in_data)
    rec.write_outbound(out_data)
    rec.stop()

    with wave.open(str(tmp_path / "call_mix" / "mix.wav"), "rb") as w:
        frames = w.readframes(w.getnframes())

    # The mix should exist and have frames
    assert len(frames) > 0

    # Since both writes happen at nearly the same wall-clock time,
    # outbound overlaps inbound → mix should contain summed samples
    samples = struct.unpack(f"<{len(frames)//2}h", frames)
    # First 4 samples should be sum: (1500, 2500, 3500, 4500)
    assert samples[0] == 1500
    assert samples[1] == 2500
    assert samples[2] == 3500
    assert samples[3] == 4500


def test_zero_length_call(tmp_path):
    """start() immediately followed by stop() produces valid empty WAV files."""
    rec = AudioRecorder(tmp_path, "empty_call")
    rec.start()
    rec.stop()

    for name in ("in.wav", "out.wav", "mix.wav"):
        with wave.open(str(tmp_path / "empty_call" / name), "rb") as w:
            assert w.getnframes() == 0
            assert w.getnchannels() == 1
            assert w.getsampwidth() == 2
            assert w.getframerate() == 8000


def test_wall_clock_gap_inserts_silence(tmp_path):
    """Wall-clock gap between writes produces silence padding."""
    from unittest.mock import patch

    rec = AudioRecorder(tmp_path, "gap_call")

    # Mock time.monotonic: start at 0.0, first write at 0.0, second at 1.0
    times = iter([0.0, 0.0, 0.0, 1.0])
    with patch("callme.recorder.time") as mock_time:
        mock_time.monotonic = lambda: next(times)

        rec.start()  # consumes 0.0
        pcm16 = struct.pack("<4h", 100, 200, 300, 400)  # 8 bytes
        rec.write_inbound(pcm16)  # consumes 0.0 (expected) + 0.0 (in _expected_bytes)
        rec.write_inbound(pcm16)  # consumes 1.0 → expected = 16000 bytes

    rec.stop()

    with wave.open(str(tmp_path / "gap_call" / "in.wav"), "rb") as w:
        frames = w.readframes(w.getnframes())

    # Total should be: 8 bytes (first) + gap silence + 8 bytes (second)
    # Gap = 16000 - 8 = 15992 bytes of silence
    # Total data in file >= 16000 bytes
    assert len(frames) >= 16000
```

- [ ] **Step 2: Run all tests**

Run: `cd /Users/ghyeok/Developments/clawops-call-me && uv run pytest tests/test_recorder.py -v`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add tests/test_recorder.py
git commit -m "test(recording): add mix overlap and clipping tests"
```

---

## Chunk 2: Session Integration

### Task 5: Integrate recorder into CallMeSession

**Files:**
- Modify: `src/callme/session.py`

- [ ] **Step 1: Add recorder import**

In `src/callme/session.py`, add import after line 24 (`from .tts_openai import OpenAITTS`):

```python
from .recorder import AudioRecorder
```

- [ ] **Step 2: Add recorder initialization in `__init__`**

In `CallMeSession.__init__` (after line 62, `self._hung_up = False`), add:

```python
        self._recorder: AudioRecorder | None = None
```

- [ ] **Step 3: Add recorder start in `start()`**

In `CallMeSession.start()`, after `self._call_ready.set()` (line 79) and before the log line, add:

```python
        if self._config.recording_enabled:
            from .daemon_lifecycle import CALLME_DIR

            rec_path = self._config.recording_path or str(CALLME_DIR / "recordings")
            self._recorder = AudioRecorder(rec_path, call.call_id)
            self._recorder.start()
```

- [ ] **Step 4: Add recorder write in `feed_audio()`**

In `CallMeSession.feed_audio()`, after `pcm16_8k = ulaw_to_pcm16(audio)` (line 87) and before the resample, add:

```python
        if self._recorder:
            self._recorder.write_inbound(pcm16_8k)
```

- [ ] **Step 5: Add recorder write in `speak()`**

In `CallMeSession.speak()`, after `pcm16_8k = resample_pcm16(...)` (line 114) and before `ulaw = pcm16_to_ulaw(pcm16_8k)`, add:

```python
        if self._recorder:
            self._recorder.write_outbound(pcm16_8k)
```

- [ ] **Step 6: Add recorder write in `speak_streaming()`**

In `CallMeSession.speak_streaming()`, inside the `while len(buffer) >= 960:` loop, after `pcm16_8k = resample_pcm16(...)` (line 134) and before `ulaw = pcm16_to_ulaw(pcm16_8k)`, add:

```python
                if self._recorder:
                    self._recorder.write_outbound(pcm16_8k)
```

Also in the remaining buffer section (line 140), after the resample and before the ulaw conversion, add:

```python
            if self._recorder:
                self._recorder.write_outbound(pcm16_8k)
```

- [ ] **Step 7: Add recorder stop in `stop()`**

In `CallMeSession.stop()`, before `self._call_ended.set()` (line 97), add:

```python
        if self._recorder:
            self._recorder.stop()
            self._recorder = None
```

- [ ] **Step 8: Add recorder cleanup in `reset()`**

In `CallMeSession.reset()`, before `self._current_call = None` (line 185), add:

```python
        if self._recorder:
            self._recorder.stop()
            self._recorder = None
```

- [ ] **Step 9: Commit**

```bash
git add src/callme/session.py
git commit -m "feat(recording): integrate AudioRecorder into CallMeSession"
```

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/ghyeok/Developments/clawops-call-me && uv run pytest tests/ -v`
Expected: ALL PASS

- [ ] **Step 2: Verify import chain works**

Run: `cd /Users/ghyeok/Developments/clawops-call-me && uv run python -c "from callme.recorder import AudioRecorder; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Verify no uncommitted changes remain**

```bash
git status
```
Expected: clean working tree (all changes already committed in previous steps)
