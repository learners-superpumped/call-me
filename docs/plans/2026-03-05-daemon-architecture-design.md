# Daemon Architecture Design

Separate ngrok + webhook server into a shared daemon process so multiple MCP server instances can share a single tunnel.

## Problem

Each MCP server instance starts its own ngrok tunnel and HTTP webhook server. When multiple Claude Code sessions run simultaneously:
- Multiple ngrok tunnels are created (wasteful, each restarts)
- Port conflicts on :3333
- Call state is isolated per process

## Architecture

```
Daemon Process (long-lived, detached)
├── ngrok tunnel
├── Webhook HTTP server (:3333)  ← phone provider callbacks
├── WebSocket server             ← media streams
├── CallManager (call state)
└── Control API (:3334)          ← MCP servers connect here

MCP Server A (stdio) ──HTTP──→ Daemon :3334
MCP Server B (stdio) ──HTTP──→ Daemon :3334
```

MCP servers become thin clients. All phone/ngrok/webhook logic lives in the daemon.

## File Structure

```
server/src/
├── index.ts              ← MCP server (thin client, ~100 lines)
├── daemon.ts             ← Daemon entrypoint (~80 lines)
├── daemon-api.ts         ← Control API router (~150 lines)
├── daemon-client.ts      ← MCP→daemon HTTP client (~120 lines)
├── daemon-lifecycle.ts   ← spawn/flock/PID/ready-wait (~100 lines)
├── phone-call.ts         ← Existing (minimal changes: add clientId ownership)
├── ngrok.ts              ← Existing (no changes)
├── webhook-security.ts   ← Existing (no changes)
└── providers/            ← Existing (no changes)
```

## Control API

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /connect | Register MCP client, get clientId, refCount++ |
| POST | /disconnect | Unregister client, refCount--, auto-shutdown if 0 |
| POST | /heartbeat | Client liveness signal (every 5s) |
| GET | /status | Daemon status (ngrokUrl, activeCalls, clients, uptime) |
| POST | /calls | Initiate call (long-poll until user responds) |
| POST | /calls/:callId/continue | Continue call (long-poll) |
| POST | /calls/:callId/speak | Speak without waiting for response |
| POST | /calls/:callId/end | End call |

### Ownership Rules

- Each call has an `ownerClientId`
- Only the owner can operate on their call
- Non-owner gets `403 Forbidden`
- Active call exists → new `POST /calls` gets `409 Conflict`
- One call at a time globally

### Heartbeat & Dead Client Detection

- MCP servers send `POST /heartbeat` every 5 seconds
- Daemon checks last heartbeat per client
- 10 seconds without heartbeat → client marked dead
  - refCount decremented
  - If client owns active call → auto-terminate call (TTS goodbye + hangup)

## Daemon Lifecycle

### Auto-start (first MCP server starts daemon)

```
MCP start
  → GET localhost:3334/status
  → Success? → POST /connect
  → ECONNREFUSED?
    → flock ~/.callme/daemon.lock
      → Acquired? → spawn daemon (detached) → wait ready → POST /connect → unlock
      → Blocked? → wait 3s → retry GET /status (max 5 times)
```

### Spawn

```typescript
spawn('bun', ['run', 'src/daemon.ts'], {
  detached: true,     // independent lifetime
  stdio: 'ignore',    // don't pollute MCP stdio
  env: { ...process.env },
});
child.unref();        // parent can exit freely
```

### Auto-shutdown (last MCP disconnects)

```
POST /disconnect → refCount--
  → refCount > 0 → keep running
  → refCount === 0 → start 30s timer
    → New /connect within 30s → cancel timer
    → Timeout → stop ngrok → process.exit(0)
```

30-second grace period covers MCP restarts.

### File System State

```
~/.callme/
├── daemon.lock    ← flock for spawn race prevention
├── daemon.pid     ← daemon PID (for liveness check via kill(pid, 0))
└── daemon.port    ← Control API port (default 3334)
```

## Changes to Existing Code

### No changes
- `providers/*`
- `webhook-security.ts`
- `ngrok.ts`

### Minimal changes — phone-call.ts
- Add `ownerClientId` to `CallState`
- Add `clientId` parameter to `initiateCall`, `continueCall`, `speakOnly`, `endCall`
- Ownership validation in each method

### Rewrite — index.ts
- Remove direct CallManager/ngrok/HTTP server usage
- Replace with `DaemonClient` that calls Control API via HTTP
- MCP tool handlers remain identical from Claude's perspective

### No changes — plugin.json
- `bun run start` still runs `index.ts`
- `index.ts` internally handles daemon auto-start
- Zero user-facing configuration changes

## Concurrency & Edge Cases

| Scenario | Solution |
|----------|----------|
| Two MCP servers spawn daemon simultaneously | flock on daemon.lock |
| Two MCP servers call POST /calls simultaneously | First wins, second gets 409 |
| MCP crashes during active call | Heartbeat timeout → auto-terminate call |
| Daemon crashes | Next MCP detects via /status failure → respawns |
| All MCP servers disconnect | 30s grace period → auto-shutdown |
| Zombie PID file (process dead, file exists) | Check kill(pid, 0) + /status response |
