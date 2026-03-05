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

- **Phone provider**: [ClawOps](https://platform.claw-ops.com) (self-hosted CPaaS), [Telnyx](https://telnyx.com), or [Twilio](https://twilio.com)
- **OpenAI API key**: For speech-to-text and text-to-speech
- **ngrok account**: Free at [ngrok.com](https://ngrok.com) (for webhook tunneling)

### 2. Set Up Phone Provider

Choose **one** of the following:

<details>
<summary><b>Option A: ClawOps (Self-hosted CPaaS — no per-minute cost)</b></summary>

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

**Environment variables for ClawOps:**

```bash
CALLME_PHONE_PROVIDER=clawops
CALLME_PHONE_ACCOUNT_SID=<Account ID>        # e.g. ACxxxxxxxxxxxxxxxx
CALLME_PHONE_API_KEY=<API Key>               # sk_... (for API authentication)
CALLME_PHONE_SIGNING_KEY=<Signing Key>       # Webhook signature verification
CALLME_PHONE_NUMBER=<Provisioned number>     # E.164 format, e.g. +821012345678
CALLME_USER_PHONE_NUMBER=<SIP extension>     # SIP username registered to Asterisk
CALLME_CLAWOPS_BASE_URL=https://api.claw-ops.com  # ClawOps API base URL (default)
```

</details>

<details>
<summary><b>Option B: Telnyx (50% cheaper than Twilio)</b></summary>

1. Create account at [portal.telnyx.com](https://portal.telnyx.com) and verify your identity
2. [Buy a phone number](https://portal.telnyx.com/#/numbers/buy-numbers) (~$1/month)
3. [Create a Voice API application](https://portal.telnyx.com/#/call-control/applications):
   - Set webhook URL to `https://your-ngrok-url/twiml` and API version to v2
     - You can see your ngrok URL on the ngrok dashboard
   - Note your **Application ID** and **API Key**
4. [Verify the phone number](https://portal.telnyx.com/#/numbers/verified-numbers) you want to receive calls at
5. (Optional but recommended) Get your **Public Key** from Account Settings > Keys & Credentials for webhook signature verification

**Environment variables for Telnyx:**

```bash
CALLME_PHONE_PROVIDER=telnyx
CALLME_PHONE_ACCOUNT_SID=<Application ID>
CALLME_PHONE_AUTH_TOKEN=<API Key>
CALLME_TELNYX_PUBLIC_KEY=<Public Key>  # Optional: enables webhook security
```

</details>

<details>
<summary><b>Option C: Twilio</b></summary>

1. Create account at [twilio.com/console](https://www.twilio.com/console)
2. Use the free number your account comes with or [buy a new phone number](https://www.twilio.com/console/phone-numbers/incoming) (~$1.15/month)
3. Find your **Account SID** and **Auth Token** on the [Console Dashboard](https://www.twilio.com/console)

**Environment variables for Twilio:**

```bash
CALLME_PHONE_PROVIDER=twilio
CALLME_PHONE_ACCOUNT_SID=<Account SID>
CALLME_PHONE_AUTH_TOKEN=<Auth Token>
```

</details>

### 3. Set Environment Variables

Add these to `~/.claude/settings.json` (recommended) or export them in your shell.

**Example: ClawOps**

```json
{
  "env": {
    "CALLME_PHONE_PROVIDER": "clawops",
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

**Example: Telnyx**

```json
{
  "env": {
    "CALLME_PHONE_PROVIDER": "telnyx",
    "CALLME_PHONE_ACCOUNT_SID": "your-connection-id",
    "CALLME_PHONE_AUTH_TOKEN": "your-api-key",
    "CALLME_PHONE_NUMBER": "+15551234567",
    "CALLME_USER_PHONE_NUMBER": "+15559876543",
    "CALLME_OPENAI_API_KEY": "sk-...",
    "CALLME_NGROK_AUTHTOKEN": "your-ngrok-token"
  }
}
```

#### Required Variables

| Variable                   | Description                                                    |
| -------------------------- | -------------------------------------------------------------- |
| `CALLME_PHONE_PROVIDER`    | `clawops`, `telnyx` (default), or `twilio`                     |
| `CALLME_PHONE_ACCOUNT_SID` | ClawOps Account ID / Telnyx Connection ID / Twilio Account SID |
| `CALLME_PHONE_AUTH_TOKEN`  | Telnyx API Key / Twilio Auth Token (not used for ClawOps)      |
| `CALLME_PHONE_API_KEY`     | ClawOps only: API key for API calls (`sk_...`)                 |
| `CALLME_PHONE_SIGNING_KEY` | ClawOps only: Webhook signing key for signature verification   |
| `CALLME_PHONE_NUMBER`      | Phone number Claude calls from (E.164 format)                  |
| `CALLME_USER_PHONE_NUMBER` | Your phone number or SIP extension to receive calls            |
| `CALLME_OPENAI_API_KEY`    | OpenAI API key (for TTS and realtime STT)                      |
| `CALLME_NGROK_AUTHTOKEN`   | ngrok auth token for webhook tunneling                         |

#### Optional Variables

| Variable                         | Default                    | Description                                                        |
| -------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| `CALLME_CLAWOPS_BASE_URL`        | `https://api.claw-ops.com` | ClawOps API base URL (ClawOps only)                                |
| `CALLME_TTS_VOICE`               | `onyx`                     | OpenAI voice: alloy, echo, fable, onyx, nova, shimmer              |
| `CALLME_PORT`                    | `3333`                     | Local HTTP server port                                             |
| `CALLME_NGROK_DOMAIN`            | -                          | Custom ngrok domain (paid feature)                                 |
| `CALLME_TRANSCRIPT_TIMEOUT_MS`   | `180000`                   | Timeout for user speech (3 minutes)                                |
| `CALLME_STT_SILENCE_DURATION_MS` | `800`                      | Silence duration to detect end of speech                           |
| `CALLME_TELNYX_PUBLIC_KEY`       | -                          | Telnyx public key for webhook signature verification (recommended) |

### 4. Install Plugin

```bash
/plugin marketplace add learners-superpumped/call-me
/plugin install callme@callme
```

Restart Claude Code. Done!

---

## How It Works

```
Claude Code                    CallMe MCP Server (local)
    │                                    │
    │  "I finished the feature..."       │
    ▼                                    ▼
Plugin ────stdio──────────────────► MCP Server
                                         │
                                         ├─► ngrok tunnel
                                         │
                                         ▼
                                   Phone Provider
                                   (ClawOps / Telnyx / Twilio)
                                         │
                                         ▼
                                   Your Phone rings
                                   You speak
                                   Text returns to Claude
```

The MCP server runs locally and automatically creates an ngrok tunnel for phone provider webhooks.

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

## Costs

| Service        | ClawOps (self-hosted)   | Telnyx      | Twilio       |
| -------------- | ----------------------- | ----------- | ------------ |
| Outbound calls | SIP trunk cost only     | ~$0.007/min | ~$0.014/min  |
| Phone number   | Provisioned via ClawOps | ~$1/month   | ~$1.15/month |

Plus OpenAI costs (same for all providers):

- **Speech-to-text**: ~$0.006/min (Realtime STT)
- **Text-to-speech**: ~$0.02/min (TTS)

**Total**: ClawOps ~$0.02/min | Telnyx ~$0.03/min | Twilio ~$0.04/min

---

## Troubleshooting

### Claude doesn't use the tool

1. Check all required environment variables are set (ideally in `~/.claude/settings.json`)
2. Restart Claude Code after installing the plugin
3. Try explicitly: "Call me to discuss the next steps when you're done."

### Call doesn't connect

1. Check the MCP server logs (stderr) with `claude --debug`
2. Verify your phone provider credentials are correct
3. Make sure ngrok can create a tunnel

### Audio issues

1. Ensure your phone number is verified with your provider
2. Check that the webhook URL in your provider dashboard matches your ngrok URL

### ngrok errors

1. Verify your `CALLME_NGROK_AUTHTOKEN` is correct
2. Check if you've hit ngrok's free tier limits
3. Try a different port with `CALLME_PORT=3334`

---

## Development

```bash
cd server
bun install
bun run dev
```

---

## License

MIT
