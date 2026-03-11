"""Configuration loading from environment variables."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field


@dataclass
class Config:
    # ClawOps SDK credentials
    account_id: str = ""
    api_key: str = ""
    base_url: str = "https://api.claw-ops.com"
    phone_number: str = ""
    user_phone_number: str = ""

    # OpenAI
    openai_api_key: str = ""

    # TTS
    tts_voice: str = "marin"
    tts_model: str = "tts-1"

    # STT
    stt_model: str = "gpt-4o-transcribe"
    stt_silence_duration_ms: int = 800

    # Timeouts
    transcript_timeout_ms: int = 180000

    # Daemon
    control_port: int = 3334

    # Safety bypass – when True, outbound/inbound number restrictions are
    # disabled. The operator assumes full responsibility for any charges,
    # abuse, or regulatory issues that result from unrestricted calling.
    unsafe_no_number_restriction: bool = False

    # Inbound
    inbound_enabled: bool = False
    inbound_workspace_dir: str = ""
    inbound_permission_mode: str = "plan"
    inbound_max_calls: int = 1
    inbound_whitelist: list[str] = field(default_factory=list)
    inbound_greeting: str = "안녕하세요, 클로드입니다."


def load_config() -> Config:
    config = Config(
        account_id=os.environ.get("CALLME_PHONE_ACCOUNT_SID", ""),
        api_key=os.environ.get("CALLME_PHONE_API_KEY", ""),
        base_url=os.environ.get("CALLME_CLAWOPS_BASE_URL", "https://api.claw-ops.com"),
        phone_number=os.environ.get("CALLME_PHONE_NUMBER", ""),
        user_phone_number=os.environ.get("CALLME_USER_PHONE_NUMBER", ""),
        openai_api_key=os.environ.get("CALLME_OPENAI_API_KEY", ""),
        tts_voice=os.environ.get("CALLME_TTS_VOICE", "onyx"),
        tts_model=os.environ.get("CALLME_TTS_MODEL", "tts-1"),
        stt_model=os.environ.get("CALLME_STT_MODEL", "gpt-4o-transcribe"),
        stt_silence_duration_ms=int(
            os.environ.get("CALLME_STT_SILENCE_DURATION_MS", "800")
        ),
        transcript_timeout_ms=int(
            os.environ.get("CALLME_TRANSCRIPT_TIMEOUT_MS", "180000")
        ),
        control_port=int(os.environ.get("CALLME_CONTROL_PORT", "3334")),
        unsafe_no_number_restriction=os.environ.get(
            "CALLME_UNSAFE_NO_NUMBER_RESTRICTION", ""
        ).lower()
        in ("true", "1", "yes"),
        inbound_enabled=os.environ.get("CALLME_INBOUND_ENABLED", "").lower()
        in ("true", "1", "yes"),
        inbound_workspace_dir=os.environ.get("CALLME_WORKSPACE_DIR", ""),
        inbound_permission_mode=os.environ.get(
            "CALLME_INBOUND_PERMISSION_MODE", "plan"
        ),
        inbound_max_calls=int(os.environ.get("CALLME_INBOUND_MAX_CALLS", "1")),
        inbound_whitelist=[
            n.strip()
            for n in os.environ.get("CALLME_INBOUND_WHITELIST", "").split(",")
            if n.strip()
        ],
        inbound_greeting=os.environ.get(
            "CALLME_INBOUND_GREETING",
            "안녕하세요, 클로드입니다. 잠시만 기다려주세요.",
        ),
    )
    return config


def compute_env_hash() -> str:
    """CALLME_* 환경변수의 해시를 계산한다."""
    pairs = sorted((k, v) for k, v in os.environ.items() if k.startswith("CALLME_"))
    raw = "\n".join(f"{k}={v}" for k, v in pairs)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def validate_config(config: Config) -> list[str]:
    errors: list[str] = []
    if not config.account_id:
        errors.append("Missing CALLME_PHONE_ACCOUNT_SID")
    if not config.api_key:
        errors.append("Missing CALLME_PHONE_API_KEY")
    if not config.phone_number:
        errors.append("Missing CALLME_PHONE_NUMBER")
    if not config.user_phone_number:
        errors.append("Missing CALLME_USER_PHONE_NUMBER")
    if not config.openai_api_key:
        errors.append("Missing CALLME_OPENAI_API_KEY")
    if config.inbound_enabled and not config.inbound_workspace_dir:
        errors.append("Missing CALLME_WORKSPACE_DIR (required when inbound enabled)")
    return errors
