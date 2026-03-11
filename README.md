# ClawOps CallMe

**Claude Code가 전화로 당신에게 연락하는 플러그인.**

작업을 시작하고 자리를 비우세요. Claude가 완료했거나, 막혔거나, 결정이 필요할 때 전화/워치가 울립니다.

<img src="./call-me-comic-min.png" width="800" alt="ClawOps CallMe 만화">

- **미니멀 플러그인** - 딱 하나의 기능: 전화 걸기. 복잡한 설정 없음.
- **다중 턴 대화** - 자연스럽게 대화하며 의사결정.
- **어디서나 동작** - 스마트폰, 스마트워치, 유선 전화까지!
- **Tool-use 조합 가능** - 통화 중에도 Claude가 웹 검색 등 다른 도구를 사용할 수 있음.

---

## 빠른 시작

### 1. 필요한 계정 준비

- **ClawOps 계정**: [platform.claw-ops.com](https://platform.claw-ops.com)에서 가입
- **OpenAI API 키**: 음성 인식(STT) 및 음성 합성(TTS)용
- **Python 3.11+** 및 [uv](https://docs.astral.sh/uv/getting-started/installation/)

### 2. ClawOps 설정

[platform.claw-ops.com](https://platform.claw-ops.com)에서 가입하고 전화번호를 등록하세요.

1. [platform.claw-ops.com](https://platform.claw-ops.com)에서 가입/로그인
2. **API & Webhooks** 페이지에서 **+ 새 키 생성** 클릭
   - `sk_...` 키가 발급됨 — 한 번만 표시되므로 저장 필수
3. 같은 페이지에서 **Account ID** (`AC...`) 복사
4. **전화번호** 페이지에서 **+ 번호 추가** 클릭
   - 등록된 번호를 `CALLME_PHONE_NUMBER`에 입력 (예: `07012341234`)
5. Claude가 전화할 내 번호를 `CALLME_USER_PHONE_NUMBER`에 입력 (예: `01012341234`)

### 3. 환경변수 설정

`~/.claude/settings.json`에 추가하세요.

```json
{
  "env": {
    "CALLME_PHONE_ACCOUNT_SID": "ACxxxxxxxxxxxxxxxx",
    "CALLME_PHONE_API_KEY": "sk_your-api-key",
    "CALLME_PHONE_NUMBER": "07012341234",
    "CALLME_USER_PHONE_NUMBER": "01012341234",
    "CALLME_OPENAI_API_KEY": "sk-..."
  }
}
```

#### 필수

| 변수                       | 설명                                             |
| -------------------------- | ------------------------------------------------ |
| `CALLME_PHONE_ACCOUNT_SID` | ClawOps Account ID (`AC...`)                     |
| `CALLME_PHONE_API_KEY`     | ClawOps API 키 (`sk_...`)                        |
| `CALLME_PHONE_NUMBER`      | ClawOps에서 등록한 발신 번호 (예: `07012341234`) |
| `CALLME_USER_PHONE_NUMBER` | Claude가 전화할 내 번호 (예: `01012341234`)      |
| `CALLME_OPENAI_API_KEY`    | OpenAI API 키 (STT + TTS)                        |

#### 인바운드 (선택)

외부에서 ClawOps 번호로 전화하면 Claude가 직접 응답합니다. [상세 설정 →](docs/architecture.md#인바운드-콜-수신-전화)

| 변수                             | 기본값          | 설명                                         |
| -------------------------------- | --------------- | -------------------------------------------- |
| `CALLME_INBOUND_ENABLED`         | `false`         | 인바운드 콜 활성화                           |
| `CALLME_WORKSPACE_DIR`           | —               | Claude CLI가 실행될 프로젝트 디렉토리 (필수) |
| `CALLME_INBOUND_WHITELIST`       | —               | 추가 허용 전화번호 (쉼표 구분)               |
| `CALLME_INBOUND_PERMISSION_MODE` | `plan`          | Claude Code 권한 모드                        |
| `CALLME_INBOUND_MAX_CALLS`       | `1`             | 최대 동시 인바운드 콜 수                     |
| `CALLME_INBOUND_GREETING`        | `안녕하세요`    | 전화 응답 시 인사 메시지                     |

#### 번호 제한 바이패스 (선택)

| 변수                                  | 기본값  | 설명                                                          |
| ------------------------------------- | ------- | ------------------------------------------------------------- |
| `CALLME_UNSAFE_NO_NUMBER_RESTRICTION` | `false` | `true` 시 아웃바운드/인바운드 번호 제한 해제 (아래 경고 참고) |

> **⚠️ 경고**: 이 옵션을 활성화하면 아웃바운드는 임의 번호로 발신 가능하고, 인바운드는 화이트리스트 없이 모든 번호에서 수신됩니다. 이로 인해 발생하는 **요금, 악용, 규제 위반 등 모든 문제는 운영자의 책임**입니다.

#### 기타 (선택)

| 변수                             | 기본값                     | 설명                                                                    |
| -------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `CALLME_CLAWOPS_BASE_URL`        | `https://api.claw-ops.com` | ClawOps API 기본 URL                                                    |
| `CALLME_TTS_VOICE`               | `nova`                     | OpenAI 음성: alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer  |
| `CALLME_CONTROL_PORT`            | `3334`                     | 데몬 제어 API 포트                                                      |
| `CALLME_TRANSCRIPT_TIMEOUT_MS`   | `180000`                   | 사용자 음성 대기 타임아웃 (3분)                                         |
| `CALLME_STT_SILENCE_DURATION_MS` | `800`                      | 발화 종료 감지 무음 시간                                                |

### 4. 플러그인 설치

```bash
/plugin marketplace add learners-superpumped/clawops-call-me
/plugin install callme@callme
```

`uv`가 설치되어 있으면 Python 의존성이 자동으로 관리됩니다. Claude Code를 재시작하면 완료!

> **전제 조건**: [uv](https://docs.astral.sh/uv/getting-started/installation/)가 설치되어 있어야 합니다 (`brew install uv` 또는 `curl -LsSf https://astral.sh/uv/install.sh | sh`)

---

## 도구(Tools)

### `initiate_call`

전화를 겁니다. `CALLME_UNSAFE_NO_NUMBER_RESTRICTION=true`일 때 `to`로 임의 번호에 발신할 수 있습니다.

```typescript
const { callId, response } = await initiate_call({
  message: "안녕하세요! 인증 시스템을 완료했어요. 다음에 뭘 작업할까요?",
  // to: "01012345678",  // 선택: 번호 제한 해제 시에만 사용 가능
});
```

### `continue_call`

후속 질문으로 대화를 이어갑니다.

```typescript
const response = await continue_call({
  call_id: callId,
  message: "알겠습니다. 레이트 리미팅도 추가할까요?",
});
```

### `speak_to_user`

응답을 기다리지 않고 사용자에게 말합니다. 시간이 오래 걸리는 작업 전에 요청을 확인할 때 유용합니다.

```typescript
await speak_to_user({
  call_id: callId,
  message: "해당 정보를 검색해볼게요. 잠시만 기다려주세요...",
});
// 시간이 걸리는 작업 수행
const results = await performSearch();
// 대화 계속
const response = await continue_call({
  call_id: callId,
  message: `${results.length}개의 결과를 찾았습니다...`,
});
```

### `end_call`

통화를 종료합니다.

```typescript
await end_call({
  call_id: callId,
  message: "좋습니다, 바로 시작할게요. 나중에 또 통화해요!",
});
```

---

## 요금제

### ClawOps

[platform.claw-ops.com](https://platform.claw-ops.com)에서 가입하여 사용합니다.

> **수신통화(인바운드)는 모든 플랜에서 무제한 무료**입니다. 비용은 발신통화(아웃바운드)에만 발생합니다.

| 플랜           | 월 요금   | 회선 (=전화번호) | 동시통화 | 발신통화     | 수신통화    |
| -------------- | --------- | ---------------- | -------- | ------------ | ----------- |
| **Starter**    | ₩19,900   | 1개              | 1건      | 60분 포함    | 무제한 무료 |
| **Growth**     | ₩49,900   | 3개              | 3건      | 300분 포함   | 무제한 무료 |
| **Business**   | ₩149,000  | 10개             | 10건     | 1,000분 포함 | 무제한 무료 |
| **Enterprise** | 별도 문의 | 맞춤             | 맞춤     | 종량제       | 무제한 무료 |

포함 분량 초과 시 발신통화 **116원/분**, 회선 추가 **1,500원/월**.

> 1회선 = 전화번호 1개 = 동시통화 1건.

### OpenAI (음성 처리)

| 서비스                   | 비용            |
| ------------------------ | --------------- |
| 음성 인식 (Realtime STT) | ~$0.006/분      |
| 음성 합성 (TTS)          | ~$0.015/1K 글자 |

**예상 비용**: 일반적인 1분 통화 기준 ~$0.03 (OpenAI만, ClawOps 통화 요금 별도)

---

## 문제 해결

### Claude가 도구를 사용하지 않는 경우

1. 모든 필수 환경변수가 설정되었는지 확인 (`~/.claude/settings.json` 권장)
2. 플러그인 설치 후 Claude Code 재시작
3. 명시적으로 요청: "작업이 끝나면 전화해서 다음 단계를 논의해줘."

### 전화가 연결되지 않는 경우

1. `claude --debug`로 MCP 서버 로그(stderr) 확인
2. ClawOps 인증 정보가 올바른지 확인

### 데몬 문제

1. `~/.callme/daemon.log`에서 데몬 로그 확인
2. 데몬 상태 확인: `curl http://127.0.0.1:3334/status`
3. 비정상 데몬 종료: `kill $(cat ~/.callme/daemon.pid)`
4. 잠금 해제: `rmdir ~/.callme/daemon.lock.d 2>/dev/null`

---

## 더 알아보기

- [동작 원리 및 아키텍처](docs/architecture.md)
- [인바운드 콜 상세 설정](docs/architecture.md#인바운드-콜-수신-전화)

---

## 개발

```bash
# MCP 서버 실행 (데몬 자동 시작, uv가 의존성 자동 관리)
uv run python -m callme

# 데몬 수동 시작
uv run python -m callme.daemon
```

---

## 라이선스

MIT
