# 동작 원리

## 아키텍처

```
Claude Code A ──stdio──► MCP Server A ──┐
Claude Code B ──stdio──► MCP Server B ──┤ HTTP (localhost:3334)
Claude Code C ──stdio──► MCP Server C ──┘
                                        │
                                        ▼
                            ClawOps CallMe Daemon (공유)
                              ├── ClawOps SDK Agent
                              │     ├── Control WS (reverse)
                              │     └── Media WS (per-call)
                              ├── CallMeSession
                              │     ├── OpenAI Realtime STT
                              │     └── OpenAI TTS
                              └── Claude CLI (인바운드)
                                        │
                                        ▼
                                    ClawOps 서버
                                        │
                                        ▼
                                  전화가 울림
                                  사용자가 말함
                                  텍스트가 Claude에게 전달
```

## 데몬 공유 모델

여러 Claude Code 세션이 하나의 데몬 프로세스를 공유합니다. 첫 번째 MCP 서버가 데몬을 자동 시작하고, 이후 서버들은 기존 데몬에 연결됩니다. 모든 MCP 서버가 연결을 끊으면 30초 후 데몬이 자동 종료됩니다.

## 인바운드 콜 (수신 전화)

외부 발신자(또는 본인)가 전화번호로 직접 전화하면 Claude가 워크스페이스 코드에 접근하여 응답합니다. 전화번호가 Claude Code의 음성 인터페이스가 됩니다.

### 인바운드 환경변수

| 변수                             | 필수             | 기본값        | 설명                                           |
| -------------------------------- | ---------------- | ------------- | ---------------------------------------------- |
| `CALLME_INBOUND_ENABLED`         | 아니오           | `false`       | 인바운드 콜 처리 활성화                        |
| `CALLME_WORKSPACE_DIR`           | 인바운드 활성 시 | —             | 인바운드 콜에서 Claude CLI가 실행되는 디렉토리 |
| `CALLME_INBOUND_WHITELIST`       | 아니오           | —             | 추가 허용 전화번호 (쉼표 구분)                 |
| `CALLME_INBOUND_PERMISSION_MODE` | 아니오           | `plan`        | 인바운드 세션의 Claude Code 권한 모드          |
| `CALLME_INBOUND_MAX_CALLS`       | 아니오           | `1`           | 최대 동시 인바운드 콜 수                       |
| `CALLME_INBOUND_GREETING`        | 아니오           | `안녕하세요`  | 전화 응답 시 인사 메시지                       |

### 동작 흐름

```
발신자가 전화번호로 전화
        │
        ▼
ClawOps → SDK Control WS → CallMe Daemon
        │
        ▼
화이트리스트 확인 (사용자 번호 자동 허용, UNSAFE 모드 시 스킵)
        │
        ▼
TTS 인사말 재생 (콜드 스타트 지연 커버)
        │
        ▼
CALLME_WORKSPACE_DIR에서 Claude CLI 실행
        │
        ▼
음성 대화 루프 (STT ↔ Claude ↔ TTS)
```

### 번호 제한 바이패스

`CALLME_UNSAFE_NO_NUMBER_RESTRICTION=true` 설정 시 아웃바운드/인바운드 번호 제한이 모두 해제됩니다.

- **아웃바운드**: `initiate_call`의 `to` 파라미터로 임의 번호에 발신 가능
- **인바운드**: 화이트리스트 체크 없이 모든 번호에서 수신 허용

> ⚠️ 이 설정으로 인해 발생하는 요금, 악용, 규제 위반 등 모든 문제는 운영자의 책임입니다.

### 참고 사항

- `CALLME_USER_PHONE_NUMBER`는 자동으로 화이트리스트에 추가됨 — 별도 등록 불필요
- TTS 인사말이 Claude CLI 콜드 스타트 지연(첫 턴에서 5~15초)을 커버
- 아웃바운드와 인바운드 콜이 동시성 제한을 공유 — 기본적으로 한 번에 한 통화만 가능
- 인바운드 세션은 워크스페이스의 기존 MCP 설정, 스킬, `CLAUDE.md`를 사용
