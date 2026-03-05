import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, openSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { lockSync, unlockSync } from './lock.js';

const CALLME_DIR = join(homedir(), '.callme');
const PID_FILE = join(CALLME_DIR, 'daemon.pid');
const PORT_FILE = join(CALLME_DIR, 'daemon.port');

const DEFAULT_CONTROL_PORT = 3334;
const DAEMON_READY_TIMEOUT_MS = 15000;
const DAEMON_READY_POLL_MS = 300;
const SPAWN_RETRY_DELAY_MS = 3000;
const MAX_SPAWN_RETRIES = 5;

function ensureDir(): void {
  mkdirSync(CALLME_DIR, { recursive: true });
}

export function getControlPort(): number {
  try {
    const port = parseInt(readFileSync(PORT_FILE, 'utf-8').trim(), 10);
    return isNaN(port) ? DEFAULT_CONTROL_PORT : port;
  } catch {
    return DEFAULT_CONTROL_PORT;
  }
}

export function writeControlPort(port: number): void {
  ensureDir();
  writeFileSync(PORT_FILE, String(port));
}

export function writePidFile(): void {
  ensureDir();
  writeFileSync(PID_FILE, String(process.pid));
}

export function cleanupPidFile(): void {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  try { unlinkSync(PORT_FILE); } catch { /* ignore */ }
}

async function isDaemonReady(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDaemonReady(port: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < DAEMON_READY_TIMEOUT_MS) {
    if (await isDaemonReady(port)) return;
    await new Promise(r => setTimeout(r, DAEMON_READY_POLL_MS));
  }
  throw new Error(`Daemon did not become ready within ${DAEMON_READY_TIMEOUT_MS}ms`);
}

function spawnDaemonProcess(serverRoot: string): void {
  const logFile = join(CALLME_DIR, 'daemon.log');
  const logFd = openSync(logFile, 'a');
  const child = spawn(process.execPath, ['run', 'src/daemon.ts'], {
    cwd: serverRoot,
    detached: true,
    stdio: ['ignore', 'ignore', logFd],
    env: { ...process.env },
  });
  child.unref();
}

function cleanStaleLock(): void {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (isNaN(pid)) {
      unlockSync(); // No valid PID, remove stale lock
      return;
    }
    try {
      process.kill(pid, 0); // Check if process exists
    } catch {
      // Process is dead, clean up stale lock
      console.error('[daemon-client] Cleaning up stale lock (daemon PID dead)');
      unlockSync();
    }
  } catch {
    // No PID file — lock might be stale from a very early crash
    // Check if lock dir exists and is older than 60 seconds
    try {
      const lockDir = join(homedir(), '.callme', 'daemon.lock.d');
      const stat = statSync(lockDir);
      if (Date.now() - stat.mtimeMs > 60000) {
        console.error('[daemon-client] Cleaning up stale lock (older than 60s)');
        unlockSync();
      }
    } catch { /* lock dir doesn't exist, that's fine */ }
  }
}

/**
 * Ensure daemon is running. Spawns if needed with directory-lock based race prevention.
 * Returns the control port.
 */
export async function ensureDaemonRunning(serverRoot: string): Promise<number> {
  const port = parseInt(process.env.CALLME_CONTROL_PORT || String(DEFAULT_CONTROL_PORT), 10);

  // Fast path: daemon already running
  if (await isDaemonReady(port)) {
    return port;
  }

  // Try to acquire lock and spawn
  ensureDir();
  // Clean up stale lock if daemon is dead
  cleanStaleLock();
  if (lockSync()) {
    try {
      // Double-check after acquiring lock
      if (!(await isDaemonReady(port))) {
        console.error('[daemon-client] Spawning daemon...');
        spawnDaemonProcess(serverRoot);
        await waitForDaemonReady(port);
        console.error('[daemon-client] Daemon is ready');
      }
    } finally {
      unlockSync();
    }
    return port;
  }

  // Lock not acquired — another process is spawning. Wait and retry.
  for (let i = 0; i < MAX_SPAWN_RETRIES; i++) {
    console.error(`[daemon-client] Waiting for daemon (attempt ${i + 1}/${MAX_SPAWN_RETRIES})...`);
    await new Promise(r => setTimeout(r, SPAWN_RETRY_DELAY_MS));
    if (await isDaemonReady(port)) return port;
  }

  throw new Error('Failed to connect to daemon after all retries');
}
