"""Daemon lifecycle: spawn, health check, shutdown management."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
import sys
from pathlib import Path

log = logging.getLogger("callme.lifecycle")

CALLME_DIR = Path.home() / ".callme"
PID_FILE = CALLME_DIR / "daemon.pid"
PORT_FILE = CALLME_DIR / "daemon.port"
LOCK_DIR = CALLME_DIR / "daemon.lock.d"
LOG_FILE = CALLME_DIR / "daemon.log"

DEFAULT_CONTROL_PORT = 3334
DAEMON_READY_TIMEOUT_S = 25.0
DAEMON_READY_POLL_S = 0.3
SPAWN_RETRY_DELAY_S = 3.0
MAX_SPAWN_RETRIES = 5


def _ensure_dir() -> None:
    CALLME_DIR.mkdir(parents=True, exist_ok=True)


def get_control_port() -> int:
    try:
        return int(PORT_FILE.read_text().strip())
    except (FileNotFoundError, ValueError):
        return DEFAULT_CONTROL_PORT


def write_control_port(port: int) -> None:
    _ensure_dir()
    PORT_FILE.write_text(str(port))


def write_pid_file() -> None:
    _ensure_dir()
    PID_FILE.write_text(str(os.getpid()))


def cleanup_pid_file() -> None:
    for f in (PID_FILE, PORT_FILE):
        try:
            f.unlink()
        except FileNotFoundError:
            pass


def lock_sync() -> bool:
    """Atomic directory-based lock. Returns True if acquired."""
    try:
        LOCK_DIR.mkdir(parents=True, exist_ok=False)
        return True
    except FileExistsError:
        return False


def unlock_sync() -> None:
    try:
        LOCK_DIR.rmdir()
    except (FileNotFoundError, OSError):
        pass


def _clean_stale_lock() -> None:
    try:
        pid = int(PID_FILE.read_text().strip())
        try:
            os.kill(pid, 0)  # Check if process alive
        except OSError:
            log.info("Cleaning stale lock (daemon PID %d dead)", pid)
            unlock_sync()
    except (FileNotFoundError, ValueError):
        # No PID file — check if lock is old
        try:
            stat = LOCK_DIR.stat()
            import time

            if time.time() - stat.st_mtime > 60:
                log.info("Cleaning stale lock (older than 60s)")
                unlock_sync()
        except FileNotFoundError:
            pass


async def _get_daemon_status(port: int) -> dict | None:
    """Returns daemon status dict, or None if not reachable."""
    import aiohttp

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"http://127.0.0.1:{port}/status",
                timeout=aiohttp.ClientTimeout(total=3),
            ) as resp:
                if resp.status == 200:
                    return await resp.json(content_type=None)
    except Exception:
        pass
    return None


async def _is_daemon_ready(port: int) -> bool:
    return await _get_daemon_status(port) is not None


async def _wait_for_daemon_ready(port: int) -> None:
    import time

    start = time.monotonic()
    while time.monotonic() - start < DAEMON_READY_TIMEOUT_S:
        if await _is_daemon_ready(port):
            return
        await asyncio.sleep(DAEMON_READY_POLL_S)
    raise RuntimeError(f"Daemon did not become ready within {DAEMON_READY_TIMEOUT_S}s")


def _spawn_daemon_process(project_root: str) -> None:
    _ensure_dir()
    log_fd = open(LOG_FILE, "a")
    # Use uv run to auto-resolve dependencies (matches plugin.json)
    import shutil

    uv_path = shutil.which("uv")
    if uv_path:
        cmd = [uv_path, "run", "python", "-m", "callme.daemon"]
    else:
        cmd = [sys.executable, "-m", "callme.daemon"]
    subprocess.Popen(
        cmd,
        cwd=project_root,
        start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=log_fd,
    )


def _stop_daemon(port: int) -> None:
    """Send SIGTERM to running daemon."""
    try:
        pid = int(PID_FILE.read_text().strip())
        os.kill(pid, signal.SIGTERM)
        log.info("Sent SIGTERM to daemon (PID %d) for restart", pid)
        import time

        for _ in range(30):
            try:
                os.kill(pid, 0)
                time.sleep(0.2)
            except OSError:
                break
    except (FileNotFoundError, ValueError, OSError):
        pass
    cleanup_pid_file()


async def ensure_daemon_running(project_root: str) -> int:
    """Ensure daemon is running. Spawns if needed. Returns control port."""
    from .config import compute_env_hash

    port = int(os.environ.get("CALLME_CONTROL_PORT", str(DEFAULT_CONTROL_PORT)))

    # Fast path: already running — check env hash
    status = await _get_daemon_status(port)
    if status is not None:
        daemon_hash = status.get("envHash", "")
        current_hash = compute_env_hash()
        if daemon_hash == current_hash:
            return port
        log.info(
            "Environment changed (hash %s → %s), restarting daemon...",
            daemon_hash[:8],
            current_hash[:8],
        )
        _stop_daemon(port)

    _ensure_dir()
    _clean_stale_lock()

    if lock_sync():
        try:
            if not await _is_daemon_ready(port):
                log.info("Spawning daemon...")
                _spawn_daemon_process(project_root)
                await _wait_for_daemon_ready(port)
                log.info("Daemon is ready")
        finally:
            unlock_sync()
        return port

    # Lock not acquired — another process is spawning
    for i in range(MAX_SPAWN_RETRIES):
        log.info("Waiting for daemon (attempt %d/%d)...", i + 1, MAX_SPAWN_RETRIES)
        await asyncio.sleep(SPAWN_RETRY_DELAY_S)
        if await _is_daemon_ready(port):
            return port

    raise RuntimeError("Failed to connect to daemon after all retries")
