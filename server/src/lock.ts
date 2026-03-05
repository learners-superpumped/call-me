import { mkdirSync, rmdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LOCK_DIR = join(homedir(), '.callme', 'daemon.lock.d');

export function lockSync(): boolean {
  try {
    mkdirSync(LOCK_DIR, { recursive: false });
    return true;
  } catch {
    return false;
  }
}

export function unlockSync(): void {
  try { rmdirSync(LOCK_DIR); } catch { /* ignore */ }
}
