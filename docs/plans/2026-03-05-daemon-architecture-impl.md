# Daemon Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate ngrok + webhook server into a shared daemon so multiple MCP instances share one tunnel.

**Architecture:** Daemon process owns ngrok/HTTP/WebSocket/CallManager. MCP servers become thin HTTP clients that connect to daemon's Control API on :3334. First MCP auto-starts daemon, last disconnect auto-shuts it down.

**Tech Stack:** Bun, Node HTTP, flock via `fs.open` + `flock`, detached child_process spawn

---

### Task 1: Add ownerClientId to CallManager

**Files:**
- Modify: `server/src/phone-call.ts:18-30` (CallState interface)
- Modify: `server/src/phone-call.ts:434-543` (public methods)

**Step 1: Add ownerClientId to CallState and method signatures**

In `phone-call.ts`, add `ownerClientId` to `CallState`:

```typescript
interface CallState {
  callId: string;
  ownerClientId: string;  // ADD THIS
  callControlId: string | null;
  // ... rest unchanged
}
```

Add `clientId` parameter and ownership check to each public method:

```typescript
async initiateCall(clientId: string, message: string): Promise<{ callId: string; response: string }> {
  // Check if any call is already active
  if (this.activeCalls.size > 0) {
    throw new CallConflictError('A call is already in progress');
  }
  const callId = `call-${++this.currentCallId}-${Date.now()}`;
  // ... existing code ...
  const state: CallState = {
    callId,
    ownerClientId: clientId,  // ADD THIS
    // ... rest unchanged
  };
  // ... rest unchanged
}

async continueCall(clientId: string, callId: string, message: string): Promise<string> {
  const state = this.activeCalls.get(callId);
  if (!state) throw new Error(`No active call: ${callId}`);
  if (state.ownerClientId !== clientId) throw new CallForbiddenError(`Not the call owner`);
  // ... rest unchanged
}

async speakOnly(clientId: string, callId: string, message: string): Promise<void> {
  const state = this.activeCalls.get(callId);
  if (!state) throw new Error(`No active call: ${callId}`);
  if (state.ownerClientId !== clientId) throw new CallForbiddenError(`Not the call owner`);
  // ... rest unchanged
}

async endCall(clientId: string, callId: string, message: string): Promise<{ durationSeconds: number }> {
  const state = this.activeCalls.get(callId);
  if (!state) throw new Error(`No active call: ${callId}`);
  if (state.ownerClientId !== clientId) throw new CallForbiddenError(`Not the call owner`);
  // ... rest unchanged
}
```

Add custom error classes at the top of the file:

```typescript
export class CallConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'CallConflictError'; }
}
export class CallForbiddenError extends Error {
  constructor(message: string) { super(message); this.name = 'CallForbiddenError'; }
}
```

Also add a method to force-end a call by clientId (for dead client cleanup):

```typescript
async forceEndCallByClient(clientId: string): Promise<void> {
  for (const [callId, state] of this.activeCalls) {
    if (state.ownerClientId === clientId) {
      try {
        await this.endCall(clientId, callId, 'Connection lost. Goodbye.');
      } catch { /* ignore errors during forced cleanup */ }
    }
  }
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/ghyeok/Developments/call-me/server && bun build src/phone-call.ts --no-bundle 2>&1 | head -20`

**Step 3: Commit**

```bash
git add server/src/phone-call.ts
git commit -m "feat: add clientId ownership to CallManager methods"
```

---

### Task 2: Create daemon-lifecycle.ts

**Files:**
- Create: `server/src/daemon-lifecycle.ts`

**Step 1: Implement daemon lifecycle management**

```typescript
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, openSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CALLME_DIR = join(homedir(), '.callme');
const LOCK_FILE = join(CALLME_DIR, 'daemon.lock');
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

function isDaemonProcessAlive(): boolean {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // Throws if process doesn't exist
    return true;
  } catch {
    return false;
  }
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
  const child = spawn('bun', ['run', 'src/daemon.ts'], {
    cwd: serverRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
}

/**
 * Ensure daemon is running. Spawns if needed with file-lock based race prevention.
 * Returns the control port.
 */
export async function ensureDaemonRunning(serverRoot: string): Promise<number> {
  const port = parseInt(process.env.CALLME_CONTROL_PORT || String(DEFAULT_CONTROL_PORT), 10);

  // Fast path: daemon already running
  if (await isDaemonReady(port)) {
    return port;
  }

  // Need to spawn — use flock to prevent race
  ensureDir();
  let lockFd: number | null = null;

  try {
    lockFd = openSync(LOCK_FILE, 'w');
  } catch {
    // Can't open lock file, fall through to retry loop
  }

  if (lockFd !== null) {
    let acquired = false;
    try {
      // Try non-blocking flock
      const { flockSync } = await import('./flock.js');
      acquired = flockSync(lockFd, 'exclusive-nonblocking');
    } catch {
      // flock not available or failed
    }

    if (acquired) {
      try {
        // Double-check after acquiring lock
        if (!(await isDaemonReady(port))) {
          console.error('[daemon-client] Spawning daemon...');
          spawnDaemonProcess(serverRoot);
          await waitForDaemonReady(port);
          console.error('[daemon-client] Daemon is ready');
        }
      } finally {
        try {
          const { flockSync } = await import('./flock.js');
          flockSync(lockFd, 'unlock');
        } catch { /* ignore */ }
        closeSync(lockFd);
      }
      return port;
    } else {
      closeSync(lockFd);
    }
  }

  // Lock not acquired — another process is spawning. Wait and retry.
  for (let i = 0; i < MAX_SPAWN_RETRIES; i++) {
    console.error(`[daemon-client] Waiting for daemon (attempt ${i + 1}/${MAX_SPAWN_RETRIES})...`);
    await new Promise(r => setTimeout(r, SPAWN_RETRY_DELAY_MS));
    if (await isDaemonReady(port)) return port;
  }

  throw new Error('Failed to connect to daemon after all retries');
}
```

**Step 2: Create flock helper (Bun-compatible)**

Create: `server/src/flock.ts`

Bun doesn't have native `flock`. Use a simple approach with Bun FFI or fallback to mkdir-based locking:

```typescript
import { mkdirSync, rmdirSync } from 'fs';

/**
 * Simple cross-platform lock using mkdir atomicity.
 * mkdir is atomic on all OS — either it succeeds or fails.
 * Less robust than real flock but works everywhere.
 */
export function flockSync(fd: number, mode: 'exclusive-nonblocking' | 'unlock'): boolean {
  // We ignore the fd and use a directory-based lock instead.
  // The lock file path is derived from the fd's path via convention.
  // This is a simplified approach — the caller passes the lock file fd,
  // and we use a .dir sibling for the actual lock.
  const lockDir = `${getLockPath()}.d`;

  if (mode === 'exclusive-nonblocking') {
    try {
      mkdirSync(lockDir);
      return true;
    } catch {
      return false;
    }
  } else {
    try { rmdirSync(lockDir); } catch { /* ignore */ }
    return true;
  }
}

function getLockPath(): string {
  const { join } = require('path');
  const { homedir } = require('os');
  return join(homedir(), '.callme', 'daemon.lock');
}
```

**Step 3: Verify it compiles**

Run: `cd /Users/ghyeok/Developments/call-me/server && bun build src/daemon-lifecycle.ts --no-bundle 2>&1 | head -20`

**Step 4: Commit**

```bash
git add server/src/daemon-lifecycle.ts server/src/flock.ts
git commit -m "feat: add daemon lifecycle management with auto-start"
```

---

### Task 3: Create daemon-api.ts

**Files:**
- Create: `server/src/daemon-api.ts`

**Step 1: Implement the Control API**

```typescript
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { CallManager, CallConflictError, CallForbiddenError } from './phone-call.js';
import { randomBytes } from 'crypto';

interface ClientInfo {
  clientId: string;
  connectedAt: number;
  lastHeartbeat: number;
}

interface DaemonApiConfig {
  callManager: CallManager;
  onRefCountZero: () => void;
  onRefCountPositive: () => void;
}

export class DaemonApi {
  private clients = new Map<string, ClientInfo>();
  private server: ReturnType<typeof createServer> | null = null;
  private config: DaemonApiConfig;
  private heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();

  constructor(config: DaemonApiConfig) {
    this.config = config;
  }

  start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(port, '127.0.0.1', () => {
        console.error(`[daemon] Control API listening on 127.0.0.1:${port}`);
        resolve();
      });

      // Check for dead clients every 5 seconds
      this.heartbeatCheckInterval = setInterval(() => this.checkDeadClients(), 5000);
    });
  }

  shutdown(): void {
    if (this.heartbeatCheckInterval) clearInterval(this.heartbeatCheckInterval);
    this.server?.close();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const method = req.method || 'GET';

    try {
      // Route matching
      if (method === 'GET' && url.pathname === '/status') {
        return this.handleStatus(res);
      }
      if (method === 'POST' && url.pathname === '/connect') {
        return this.handleConnect(res);
      }
      if (method === 'POST' && url.pathname === '/disconnect') {
        return await this.handleDisconnect(req, res);
      }
      if (method === 'POST' && url.pathname === '/heartbeat') {
        return await this.handleHeartbeat(req, res);
      }
      if (method === 'POST' && url.pathname === '/calls') {
        return await this.handleInitiateCall(req, res);
      }

      // /calls/:callId/* routes
      const callMatch = url.pathname.match(/^\/calls\/([^/]+)\/(continue|speak|end)$/);
      if (method === 'POST' && callMatch) {
        const [, callId, action] = callMatch;
        return await this.handleCallAction(req, res, callId, action);
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      console.error('[daemon-api] Unhandled error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  private handleStatus(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.round((Date.now() - this.startTime) / 1000),
      connectedClients: this.clients.size,
      clientIds: Array.from(this.clients.keys()),
    }));
  }

  private handleConnect(res: ServerResponse): void {
    const clientId = randomBytes(16).toString('hex');
    this.clients.set(clientId, {
      clientId,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
    });
    this.config.onRefCountPositive();
    console.error(`[daemon] Client connected: ${clientId} (total: ${this.clients.size})`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ clientId }));
  }

  private async handleDisconnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const { clientId } = JSON.parse(body);
    await this.removeClient(clientId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private async handleHeartbeat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const { clientId } = JSON.parse(body);
    const client = this.clients.get(clientId);
    if (client) {
      client.lastHeartbeat = Date.now();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private async handleInitiateCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const { clientId, message } = JSON.parse(body);

    if (!this.clients.has(clientId)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unknown client' }));
      return;
    }

    try {
      const result = await this.config.callManager.initiateCall(clientId, message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof CallConflictError) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: error.message }));
      } else {
        throw error;
      }
    }
  }

  private async handleCallAction(
    req: IncomingMessage, res: ServerResponse,
    callId: string, action: string
  ): Promise<void> {
    const body = await readBody(req);
    const { clientId, message } = JSON.parse(body);

    if (!this.clients.has(clientId)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unknown client' }));
      return;
    }

    try {
      let result: unknown;
      switch (action) {
        case 'continue':
          result = { response: await this.config.callManager.continueCall(clientId, callId, message) };
          break;
        case 'speak':
          await this.config.callManager.speakOnly(clientId, callId, message);
          result = { ok: true };
          break;
        case 'end':
          result = await this.config.callManager.endCall(clientId, callId, message);
          break;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof CallForbiddenError) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: error.message }));
      } else {
        throw error;
      }
    }
  }

  private async removeClient(clientId: string): Promise<void> {
    if (!this.clients.has(clientId)) return;
    // Force-end any calls owned by this client
    await this.config.callManager.forceEndCallByClient(clientId);
    this.clients.delete(clientId);
    console.error(`[daemon] Client disconnected: ${clientId} (total: ${this.clients.size})`);
    if (this.clients.size === 0) {
      this.config.onRefCountZero();
    }
  }

  private async checkDeadClients(): Promise<void> {
    const now = Date.now();
    const deadTimeout = 10000; // 10 seconds
    for (const [clientId, info] of this.clients) {
      if (now - info.lastHeartbeat > deadTimeout) {
        console.error(`[daemon] Client ${clientId} heartbeat timeout, removing`);
        await this.removeClient(clientId);
      }
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/ghyeok/Developments/call-me/server && bun build src/daemon-api.ts --no-bundle 2>&1 | head -20`

**Step 3: Commit**

```bash
git add server/src/daemon-api.ts
git commit -m "feat: add daemon Control API with client management"
```

---

### Task 4: Create daemon.ts entrypoint

**Files:**
- Create: `server/src/daemon.ts`

**Step 1: Implement daemon entrypoint**

```typescript
#!/usr/bin/env bun

import { CallManager, loadServerConfig } from './phone-call.js';
import { startNgrok, stopNgrok } from './ngrok.js';
import { DaemonApi } from './daemon-api.js';
import { writePidFile, writeControlPort, cleanupPidFile } from './daemon-lifecycle.js';

async function main() {
  const webhookPort = parseInt(process.env.CALLME_PORT || '3333', 10);
  const controlPort = parseInt(process.env.CALLME_CONTROL_PORT || '3334', 10);

  // Write PID and port files for clients to discover
  writePidFile();
  writeControlPort(controlPort);

  // Start ngrok
  console.error('[daemon] Starting ngrok tunnel...');
  let publicUrl: string;
  try {
    publicUrl = await startNgrok(webhookPort);
    console.error(`[daemon] ngrok tunnel: ${publicUrl}`);
  } catch (error) {
    console.error('[daemon] Failed to start ngrok:', error instanceof Error ? error.message : error);
    cleanupPidFile();
    process.exit(1);
  }

  // Load config and create CallManager
  let serverConfig;
  try {
    serverConfig = loadServerConfig(publicUrl);
  } catch (error) {
    console.error('[daemon] Configuration error:', error instanceof Error ? error.message : error);
    await stopNgrok();
    cleanupPidFile();
    process.exit(1);
  }

  const callManager = new CallManager(serverConfig);
  callManager.startServer();

  // Auto-shutdown timer
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  const SHUTDOWN_GRACE_MS = 30000;

  const daemonApi = new DaemonApi({
    callManager,
    onRefCountZero: () => {
      console.error(`[daemon] No clients connected, shutting down in ${SHUTDOWN_GRACE_MS / 1000}s...`);
      shutdownTimer = setTimeout(() => shutdown(), SHUTDOWN_GRACE_MS);
    },
    onRefCountPositive: () => {
      if (shutdownTimer) {
        console.error('[daemon] Client reconnected, cancelling shutdown');
        clearTimeout(shutdownTimer);
        shutdownTimer = null;
      }
    },
  });

  await daemonApi.start(controlPort);

  console.error('[daemon] Ready');
  console.error(`[daemon] Webhook: ${publicUrl} (port ${webhookPort})`);
  console.error(`[daemon] Control API: http://127.0.0.1:${controlPort}`);

  // Graceful shutdown
  const shutdown = async () => {
    console.error('[daemon] Shutting down...');
    daemonApi.shutdown();
    callManager.shutdown();
    await stopNgrok();
    cleanupPidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[daemon] Fatal error:', error);
  cleanupPidFile();
  process.exit(1);
});
```

**Step 2: Verify it compiles**

Run: `cd /Users/ghyeok/Developments/call-me/server && bun build src/daemon.ts --no-bundle 2>&1 | head -20`

**Step 3: Commit**

```bash
git add server/src/daemon.ts
git commit -m "feat: add daemon entrypoint"
```

---

### Task 5: Create daemon-client.ts

**Files:**
- Create: `server/src/daemon-client.ts`

**Step 1: Implement MCP-side daemon client**

```typescript
import { ensureDaemonRunning, getControlPort } from './daemon-lifecycle.js';

export class DaemonClient {
  private controlPort: number = 0;
  private clientId: string = '';
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private serverRoot: string;

  constructor(serverRoot: string) {
    this.serverRoot = serverRoot;
  }

  async connect(): Promise<void> {
    this.controlPort = await ensureDaemonRunning(this.serverRoot);

    const res = await this.post('/connect', {});
    const data = await res.json() as { clientId: string };
    this.clientId = data.clientId;
    console.error(`[mcp] Connected to daemon as ${this.clientId}`);

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.post('/heartbeat', { clientId: this.clientId }).catch(() => {
        console.error('[mcp] Heartbeat failed');
      });
    }, 5000);
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    try {
      await this.post('/disconnect', { clientId: this.clientId });
    } catch {
      // Daemon may already be gone
    }
  }

  async initiateCall(message: string): Promise<{ callId: string; response: string }> {
    const res = await this.post('/calls', { clientId: this.clientId, message }, 300000);
    if (res.status === 409) {
      const data = await res.json() as { error: string };
      throw new Error(data.error);
    }
    if (!res.ok) throw new Error(`Daemon error: ${res.status}`);
    return await res.json() as { callId: string; response: string };
  }

  async continueCall(callId: string, message: string): Promise<string> {
    const res = await this.post(`/calls/${callId}/continue`, { clientId: this.clientId, message }, 300000);
    if (!res.ok) throw new Error(`Daemon error: ${res.status}`);
    const data = await res.json() as { response: string };
    return data.response;
  }

  async speakOnly(callId: string, message: string): Promise<void> {
    const res = await this.post(`/calls/${callId}/speak`, { clientId: this.clientId, message }, 60000);
    if (!res.ok) throw new Error(`Daemon error: ${res.status}`);
  }

  async endCall(callId: string, message: string): Promise<{ durationSeconds: number }> {
    const res = await this.post(`/calls/${callId}/end`, { clientId: this.clientId, message }, 60000);
    if (!res.ok) throw new Error(`Daemon error: ${res.status}`);
    return await res.json() as { durationSeconds: number };
  }

  private async post(path: string, body: unknown, timeoutMs = 10000): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`http://127.0.0.1:${this.controlPort}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/ghyeok/Developments/call-me/server && bun build src/daemon-client.ts --no-bundle 2>&1 | head -20`

**Step 3: Commit**

```bash
git add server/src/daemon-client.ts
git commit -m "feat: add daemon HTTP client for MCP servers"
```

---

### Task 6: Rewrite index.ts as thin client

**Files:**
- Modify: `server/src/index.ts` (full rewrite)

**Step 1: Replace index.ts with thin client**

```typescript
#!/usr/bin/env bun

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient } from './daemon-client.js';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = dirname(__dirname); // server/

async function main() {
  // Connect to daemon (auto-starts if needed)
  const daemon = new DaemonClient(serverRoot);
  console.error('Connecting to daemon...');
  await daemon.connect();
  console.error('Connected to daemon');

  // Create stdio MCP server
  const mcpServer = new Server(
    { name: 'callme', version: '3.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools (unchanged)
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'initiate_call',
          description: 'Start a phone call with the user. Use when you need voice input, want to report completed work, or need real-time discussion.',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'What you want to say to the user. Be natural and conversational.',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'continue_call',
          description: 'Continue an active call with a follow-up message.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'Your follow-up message' },
            },
            required: ['call_id', 'message'],
          },
        },
        {
          name: 'speak_to_user',
          description: 'Speak a message on an active call without waiting for a response. Use this to acknowledge requests or provide status updates before starting time-consuming operations.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'What to say to the user' },
            },
            required: ['call_id', 'message'],
          },
        },
        {
          name: 'end_call',
          description: 'End an active call with a closing message.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'Your closing message (say goodbye!)' },
            },
            required: ['call_id', 'message'],
          },
        },
      ],
    };
  });

  // Handle tool calls — delegate to daemon
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === 'initiate_call') {
        const { message } = request.params.arguments as { message: string };
        const result = await daemon.initiateCall(message);
        return {
          content: [{
            type: 'text',
            text: `Call initiated successfully.\n\nCall ID: ${result.callId}\n\nUser's response:\n${result.response}\n\nUse continue_call to ask follow-ups or end_call to hang up.`,
          }],
        };
      }

      if (request.params.name === 'continue_call') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        const response = await daemon.continueCall(call_id, message);
        return {
          content: [{ type: 'text', text: `User's response:\n${response}` }],
        };
      }

      if (request.params.name === 'speak_to_user') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        await daemon.speakOnly(call_id, message);
        return {
          content: [{ type: 'text', text: `Message spoken: "${message}"` }],
        };
      }

      if (request.params.name === 'end_call') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        const { durationSeconds } = await daemon.endCall(call_id, message);
        return {
          content: [{ type: 'text', text: `Call ended. Duration: ${durationSeconds}s` }],
        };
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  // Connect MCP server via stdio
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error('');
  console.error('CallMe MCP server ready (daemon mode)');
  console.error('');

  // Graceful shutdown
  const shutdown = async () => {
    console.error('\nShutting down...');
    await daemon.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
```

**Step 2: Verify it compiles**

Run: `cd /Users/ghyeok/Developments/call-me/server && bun build src/index.ts --no-bundle 2>&1 | head -20`

**Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "feat: rewrite index.ts as thin daemon client"
```

---

### Task 7: Integration test — manual smoke test

**Step 1: Start daemon manually and verify Control API**

```bash
cd /Users/ghyeok/Developments/call-me/server
bun run src/daemon.ts &
sleep 3
curl -s http://127.0.0.1:3334/status | jq .
# Expected: { "status": "ok", "connectedClients": 0, ... }
```

**Step 2: Test connect/disconnect lifecycle**

```bash
# Connect
CLIENT=$(curl -s -X POST http://127.0.0.1:3334/connect | jq -r .clientId)
echo "ClientId: $CLIENT"

# Check status
curl -s http://127.0.0.1:3334/status | jq .
# Expected: connectedClients: 1

# Disconnect
curl -s -X POST http://127.0.0.1:3334/disconnect -H 'Content-Type: application/json' -d "{\"clientId\":\"$CLIENT\"}"

# Check status — should start 30s shutdown timer
curl -s http://127.0.0.1:3334/status | jq .
# Expected: connectedClients: 0
```

**Step 3: Test MCP server with daemon**

```bash
# Kill any running daemon
kill $(cat ~/.callme/daemon.pid) 2>/dev/null

# Start MCP server (should auto-spawn daemon)
bun run src/index.ts
# Expected: "Connecting to daemon..." → "Spawning daemon..." → "Connected to daemon"
```

**Step 4: Commit final adjustments**

```bash
git add -A
git commit -m "fix: integration test adjustments"
```

---

### Task 8: Add daemon start script to package.json

**Files:**
- Modify: `server/package.json`

**Step 1: Add daemon script**

Add to `scripts`:

```json
{
  "scripts": {
    "prestart": "bun install --silent",
    "start": "bun run src/index.ts",
    "daemon": "bun run src/daemon.ts",
    "dev": "bun --watch src/index.ts"
  }
}
```

**Step 2: Commit**

```bash
git add server/package.json
git commit -m "chore: add daemon script to package.json"
```
