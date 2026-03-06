# CallMe

**Minimal plugin that lets Claude Code call you on the phone.**

Start a task, walk away. Your phone/watch rings when Claude is done, stuck, or needs a decision.

<img src="./call-me-comic-min.png" width="800" alt="CallMe comic strip">

- **Minimal plugin** - Does one thing: call you on the phone. No crazy setups.
- **Multi-turn conversations** - Talk through decisions naturally.
- **Works anywhere** - Smartphone, smartwatch, or even landline!
- **Tool-use composable** - Claude can e.g. do a web search while on a call with you.

---

## Quick Start

### 1. Get Required Accounts

You'll need:

- **Phone provider**: [ClawOps](https://platform.claw-ops.com) (self-hosted CPaaS)
- **OpenAI API key**: For speech-to-text and text-to-speech
- **ngrok account**: Free at [ngrok.com](https://ngrok.com) (for webhook tunneling)

### 2. Set Up Phone Provider

[ClawOps](https://platform.claw-ops.com) is a self-hosted Asterisk-based CPaaS that provides a Twilio-compatible Voice API. Use this if you have your own SIP trunk (e.g. KT Business).

**Prerequisites**: A running ClawOps instance.

**Steps:**

1. Log in to the ClawOps web dashboard
2. Go to **Settings → API Keys** and create an API key (you'll get an `sk_...` key — save it, it's only shown once)
3. Copy your **Account ID** and **Webhook Signing Key** from the same settings page
4. Provision a phone number via the dashboard (`Numbers` → `Provision Number`)
   - The provisioned number is used as `CALLME_PHONE_NUMBER`
5. Register your SIP softphone (e.g. Linphone) using the SIP credentials shown after provisioning
   - The softphone extension is used as `CALLME_USER_PHONE_NUMBER`

### 3. Set Environment Variables

Add these to `~/.claude/settings.json` (recommended) or export them in your shell.

```json
{
  "env": {
    "CALLME_PHONE_ACCOUNT_SID": "ACxxxxxxxxxxxxxxxx",
    "CALLME_PHONE_API_KEY": "sk_your-api-key",
    "CALLME_PHONE_SIGNING_KEY": "your-signing-key",
    "CALLME_PHONE_NUMBER": "+821012345678",
    "CALLME_USER_PHONE_NUMBER": "softphone",
    "CALLME_CLAWOPS_BASE_URL": "https://api.claw-ops.com",
    "CALLME_OPENAI_API_KEY": "sk-...",
    "CALLME_NGROK_AUTHTOKEN": "your-ngrok-token"
  }
}
```

#### Required Variables

| Variable                   | Description                                        |
| -------------------------- | -------------------------------------------------- |
| `CALLME_PHONE_ACCOUNT_SID` | ClawOps Account ID (`AC...`)                       |
| `CALLME_PHONE_API_KEY`     | ClawOps API key for API calls (`sk_...`)            |
| `CALLME_PHONE_SIGNING_KEY` | ClawOps Webhook signing key for signature verification |
| `CALLME_PHONE_NUMBER`      | Phone number Claude calls from (E.164 format)      |
| `CALLME_USER_PHONE_NUMBER` | Your phone number or SIP extension to receive calls |
| `CALLME_OPENAI_API_KEY`    | OpenAI API key (for TTS and realtime STT)          |
| `CALLME_NGROK_AUTHTOKEN`   | ngrok auth token for webhook tunneling             |

#### Optional Variables

| Variable                         | Default                    | Description                                           |
| -------------------------------- | -------------------------- | ----------------------------------------------------- |
| `CALLME_CLAWOPS_BASE_URL`        | `https://api.claw-ops.com` | ClawOps API base URL                                  |
| `CALLME_TTS_VOICE`               | `onyx`                     | OpenAI voice: alloy, echo, fable, onyx, nova, shimmer |
| `CALLME_PORT`                    | `3333`                     | Webhook HTTP server port                              |
| `CALLME_CONTROL_PORT`            | `3334`                     | Daemon control API port                               |
| `CALLME_NGROK_DOMAIN`            | -                          | Custom ngrok domain (paid feature)                    |
| `CALLME_TRANSCRIPT_TIMEOUT_MS`   | `180000`                   | Timeout for user speech (3 minutes)                   |
| `CALLME_STT_SILENCE_DURATION_MS` | `800`                      | Silence duration to detect end of speech              |

### 4. Install Plugin

```bash
/plugin marketplace add learners-superpumped/call-me
/plugin install callme@callme
```

Restart Claude Code. Done!

---

## How It Works

```
Claude Code A ──stdio──► MCP Server A ──┐
Claude Code B ──stdio──► MCP Server B ──┤ HTTP (localhost:3334)
Claude Code C ──stdio──► MCP Server C ──┘
                                        │
                                        ▼
                              CallMe Daemon (shared)
                              ├── ngrok tunnel (single)
                              ├── Webhook HTTP server
                              ├── WebSocket media streams
                              └── Call Manager
                                        │
                                        ▼
                                    ClawOps
                                        │
                                        ▼
                                  Your Phone rings
                                  You speak
                                  Text returns to Claude
```

Multiple Claude Code sessions share a single daemon process. The first MCP server auto-starts the daemon; subsequent ones connect to it. The daemon manages one ngrok tunnel, one webhook server, and all call state. When all MCP servers disconnect, the daemon shuts down after 30 seconds.

---

## Tools

### `initiate_call`

Start a phone call.

```typescript
const { callId, response } = await initiate_call({
  message: "Hey! I finished the auth system. What should I work on next?",
});
```

### `continue_call`

Continue with follow-up questions.

```typescript
const response = await continue_call({
  call_id: callId,
  message: "Got it. Should I add rate limiting too?",
});
```

### `speak_to_user`

Speak to the user without waiting for a response. Useful for acknowledging requests before time-consuming operations.

```typescript
await speak_to_user({
  call_id: callId,
  message: "Let me search for that information. Give me a moment...",
});
// Continue with your long-running task
const results = await performSearch();
// Then continue the conversation
const response = await continue_call({
  call_id: callId,
  message: `I found ${results.length} results...`,
});
```

### `end_call`

End the call.

```typescript
await end_call({
  call_id: callId,
  message: "Perfect, I'll get started. Talk soon!",
});
```

---

## Inbound Calls

External callers (or you) can call the phone number directly, and Claude will answer with full access to your workspace code. This turns your phone number into a voice interface for Claude Code.

### Setup

Enable inbound calls by adding these variables alongside your existing configuration:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CALLME_INBOUND_ENABLED` | No | `false` | Enable inbound call handling |
| `CALLME_WORKSPACE_DIR` | When inbound enabled | — | Directory where Claude CLI runs for inbound calls |
| `CALLME_INBOUND_WHITELIST` | No | — | Additional allowed phone numbers (comma-separated, E.164) |
| `CALLME_INBOUND_PERMISSION_MODE` | No | `plan` | Claude Code permission mode for inbound sessions |
| `CALLME_INBOUND_MAX_CALLS` | No | `1` | Max concurrent inbound calls |
| `CALLME_INBOUND_GREETING` | No | Korean default | Greeting message when call is answered |

### How It Works

```
Caller dials your number
        │
        ▼
ClawOps → webhook → CallMe Daemon
        │
        ▼
Whitelist check (user number auto-allowed)
        │
        ▼
TTS greeting plays (covers cold start delay)
        │
        ▼
Claude CLI spawns in CALLME_WORKSPACE_DIR
        │
        ▼
Voice conversation loop (STT ↔ Claude ↔ TTS)
```

1. An incoming call hits the daemon via webhook
2. The caller's number is checked against the whitelist
3. A TTS greeting plays immediately, covering the 5–15s cold start while Claude CLI launches
4. Claude CLI spawns in `CALLME_WORKSPACE_DIR` with your MCP settings, skills, and `CLAUDE.md`
5. The caller speaks naturally with Claude through the voice conversation loop

### Notes

- Your phone number (`CALLME_USER_PHONE_NUMBER`) is automatically whitelisted — no need to add it separately
- The greeting TTS covers the Claude CLI cold start delay (5–15s on first turn)
- Outbound and inbound calls share the concurrency limit — only one call at a time by default
- Inbound sessions use existing MCP settings, skills, and `CLAUDE.md` from the workspace

---

## Costs

| Service        | Cost                      |
| -------------- | ------------------------- |
| Outbound calls | SIP trunk cost only       |
| Phone number   | Provisioned via ClawOps   |

Plus OpenAI costs:

- **Speech-to-text**: ~$0.006/min (Realtime STT)
- **Text-to-speech**: ~$0.02/min (TTS)

**Total**: ~$0.02/min + SIP trunk

---

## Troubleshooting

### Claude doesn't use the tool

1. Check all required environment variables are set (ideally in `~/.claude/settings.json`)
2. Restart Claude Code after installing the plugin
3. Try explicitly: "Call me to discuss the next steps when you're done."

### Call doesn't connect

1. Check the MCP server logs (stderr) with `claude --debug`
2. Verify your ClawOps credentials are correct
3. Make sure ngrok can create a tunnel

### Audio issues

1. Ensure your phone number is provisioned in ClawOps
2. Check that the webhook URL matches your ngrok URL

### ngrok errors

1. Verify your `CALLME_NGROK_AUTHTOKEN` is correct
2. Check if you've hit ngrok's free tier limits
3. Try a different port with `CALLME_PORT=3335`

### Daemon issues

1. Check daemon logs at `~/.callme/daemon.log`
2. Check daemon status: `curl http://127.0.0.1:3334/status`
3. Kill stale daemon: `kill $(cat ~/.callme/daemon.pid)`
4. Clean up lock: `rmdir ~/.callme/daemon.lock.d 2>/dev/null`

---

## Development

```bash
cd server
bun install
bun run dev          # MCP server (auto-starts daemon)
bun run daemon       # Start daemon manually
```

---

## License

MIT
