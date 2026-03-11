# Recording Feature Design

## Overview

clawops-call-me에 통화 녹음 기능을 추가한다. Python SDK의 `AudioRecorder`에서 영감을 받되, wall-clock 타이머 동기화와 실시간 3-file mix는 새로 설계한다. SDK 원본은 2-file append-only(in.wav + raw.ulaw)이며, 이 설계는 시간 동기화된 3-WAV 파일 생성으로 확장한다.

## Requirements

- 통화 중 inbound(caller), outbound(AI), mix(합성) 3개 WAV 파일을 실시간 기록
- 세 파일 모두 동일한 길이를 유지하여 실제 통화 녹음처럼 자연스럽게 재생
- 환경변수로 on/off 제어 (기본값: on)
- `~/.callme/recordings/{call_id}/` 디렉토리에 저장

## Output Structure

```
~/.callme/recordings/
└── {call_id}/
    ├── in.wav      # caller 음성 (PCM16 8kHz mono)
    ├── out.wav     # AI 음성 (PCM16 8kHz mono)
    └── mix.wav     # 양쪽 합성 (PCM16 8kHz mono)
```

## Architecture

### New File: `src/callme/recorder.py`

#### AudioRecorder Class

통화별 인스턴스. 3개 WAV 파일을 wall-clock 동기화로 실시간 기록한다.

**WAV Format:**
- Sample rate: 8000 Hz
- Channels: 1 (mono)
- Bits per sample: 16 (PCM16 signed LE)
- Header size: 44 bytes

**Constructor:**
```python
AudioRecorder(path: str | Path, call_id: str)
```
- `path`: 녹음 베이스 디렉토리 (기본 `~/.callme/recordings`)
- `call_id`: 통화 ID (폴더명으로 사용)

**Methods:**

`start() -> None`
- `{path}/{call_id}/` 디렉토리 생성
- `in.wav`, `out.wav`, `mix.wav` 3개 파일 열기
- 각 파일에 WAV 헤더(data_size=0) 작성
- `time.monotonic()`으로 기준 시각 저장
- `_in_written`, `_out_written`, `_mix_written` 바이트 카운터 초기화

`write_inbound(pcm16: bytes) -> None`
- 수신 오디오 기록 (PCM16 8kHz)
- Wall-clock gap 계산: `expected = int((now - start) * 8000 * 2)`
- `_in_written < expected`이면 차이만큼 `\x00` 무음 패딩 후 기록
- mix 파일에도 동일 위치에 기록 (겹침 시 샘플 합산)

`write_outbound(pcm16: bytes) -> None`
- 송신 오디오 기록 (PCM16 8kHz, TTS에서 리샘플 후 전달)
- Wall-clock gap 동일 처리
- mix 파일에도 동일 위치에 기록 (겹침 시 샘플 합산)

`stop() -> None`
- 세 파일 모두 최종 길이로 WAV 헤더 업데이트 (seek(0) → 헤더 재작성)
- 짧은 트랙을 가장 긴 트랙 길이에 맞춰 무음 패딩 (최종 길이 동기화)
- 파일 close
- 로그 출력

#### Wall-clock Synchronization

```
timeline:  0s -------- 2s -------- 4s -------- 6s
inbound:   [audio][audio][audio][audio][audio][audio]  (연속 스트림)
outbound:  [silence  ][  TTS audio  ][silence ][TTS..]
mix:       [in only  ][in + out mix ][in only ][mix..]
```

- 기준: `time.monotonic()` at `start()`
- 각 write 호출 시: `elapsed = now - start_time`
- `expected_bytes = int(elapsed * SAMPLE_RATE * BYTES_PER_SAMPLE)`
- 트랙의 `_written`이 `expected_bytes`보다 적으면 차이만큼 무음 삽입

#### Mix Overlap Handling

두 트랙이 동시에 존재하는 구간 (인터럽트, 동시 발화):
1. mix 파일에서 해당 offset(WAV_HEADER_SIZE + byte_position)으로 seek
2. 기존 데이터 read (이미 기록된 다른 트랙의 샘플)
3. `struct.unpack`으로 int16 배열 디코딩, Python int로 합산 후 clamp(-32768, 32767), `struct.pack`으로 재인코딩
4. seek back → write

겹치지 않는 구간:
- 해당 트랙 데이터를 그대로 mix에 기록 (gap 무음 포함)

**동시성 안전:** asyncio는 단일 스레드 이벤트 루프이므로 `write_inbound`와 `write_outbound`는 동일 스레드에서 실행된다. 두 메서드 모두 sync이고 내부에 `await` 없이 완료되므로 인터리브 없이 원자적으로 실행된다. 별도 lock이 필요하지 않다.

**Sync I/O 허용 근거:** 오디오 청크는 20ms 단위(ulaw 160B → PCM16 320B)로 매우 작다. 파일 I/O는 OS 페이지 캐시에서 처리되어 sub-millisecond이므로 이벤트 루프 블로킹 영향 무시 가능.

### Modified File: `src/callme/session.py`

#### CallMeSession 변경

**`__init__`에 recorder 필드 추가:**
- `self._recorder: AudioRecorder | None = None`
- config에서 recording 설정 참조

**`start(call)` 변경:**
- recording 활성화 시 `AudioRecorder(path, call.call_id)` 생성
- `recorder.start()` 호출

**`feed_audio(audio, timestamp)` 변경:**
- 기존: `ulaw → pcm16_8k → pcm16_24k → STT`
- 추가: `pcm16_8k`를 `recorder.write_inbound(pcm16_8k)` 전달

**`speak(text)` 변경:**
- 기존: `TTS → pcm16_24k → pcm16_8k → ulaw → send`
- 추가: `pcm16_8k` 단계에서 `recorder.write_outbound(pcm16_8k)` 전달

**`speak_streaming(text)` 변경:**
- 기존: 청크별 `pcm16_24k → pcm16_8k → ulaw → send`
- 추가: 각 청크의 `pcm16_8k`를 `recorder.write_outbound(pcm16_8k)` 전달

**`stop()` 변경:**
- `recorder.stop()` 호출하여 WAV 헤더 확정 및 파일 close

**`reset()` 변경:**
- recorder 참조 해제

### Modified File: `src/callme/config.py`

```python
# Config dataclass 추가 필드
recording_enabled: bool = True
recording_path: str = ""
```

**`recording_path` 해석:** `load_config()`에서 환경변수가 빈 문자열이면 빈 문자열 그대로 저장. `session.py`에서 `AudioRecorder` 생성 시 빈 문자열이면 `~/.callme/recordings`로 resolve한다.

```python
# load_config() 추가
recording_enabled=os.environ.get("CALLME_RECORDING_ENABLED", "true").lower() in ("true", "1", "yes"),
recording_path=os.environ.get("CALLME_RECORDING_PATH", ""),
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CALLME_RECORDING_ENABLED` | `true` | 녹음 on/off |
| `CALLME_RECORDING_PATH` | `~/.callme/recordings` | 녹음 파일 저장 경로 |

## Change Summary

| File | Change |
|------|--------|
| `src/callme/recorder.py` | **신규** — AudioRecorder 클래스 |
| `src/callme/session.py` | recorder 통합 (feed_audio, speak, speak_streaming, start, stop, reset) |
| `src/callme/config.py` | recording_enabled, recording_path 필드 및 환경변수 로딩 추가 |

## Edge Cases

- **짧은 통화:** 데이터가 적어도 WAV 헤더는 유효하게 생성
- **크래시:** 실시간 기록이므로 크래시 시점까지의 오디오는 보존 (헤더만 부정확할 수 있음)
- **디스크 에러:** write 실패 시 로그만 남기고 통화는 계속 진행 (녹음은 best-effort)
- **동시 발화 (인터럽트):** 샘플 합산 + clipping 방지로 자연스러운 mix 유지
- **인바운드/아웃바운드 통화 모두 지원:** 둘 다 동일한 `CallMeSession`을 통하므로 녹음이 자동 적용됨. `reset()`에서 recorder를 정리하며, outbound(`on_call_end`)와 inbound(`_run_inbound_conversation` finally) 양쪽 경로 모두 `reset()`을 호출한다.

## Testing

- **Unit tests:** AudioRecorder의 write_inbound only, write_outbound only, 겹침 구간, gap 삽입 검증
- **WAV 유효성:** 출력 파일이 표준 WAV 플레이어에서 재생 가능한지 확인
- **Edge cases:** 0초 통화, 한쪽만 음성 있는 경우, 긴 무음 gap 후 재개
