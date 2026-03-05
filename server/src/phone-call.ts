import WebSocket, { WebSocketServer } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import {
  loadProviderConfig,
  createProviders,
  validateProviderConfig,
  type ProviderRegistry,
  type ProviderConfig,
  type RealtimeSTTSession,
} from './providers/index.js';
import {
  validateTwilioSignature,
  validateTelnyxSignature,
  generateWebSocketToken,
  validateWebSocketToken,
} from './webhook-security.js';
import { ClaudeSessionManager } from './claude-session.js';

export class CallConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'CallConflictError'; }
}
export class CallForbiddenError extends Error {
  constructor(message: string) { super(message); this.name = 'CallForbiddenError'; }
}

interface CallState {
  callId: string;
  ownerClientId: string;
  callControlId: string | null;
  userPhoneNumber: string;
  ws: WebSocket | null;
  streamSid: string | null;  // Twilio media stream ID (required for sending audio)
  streamingReady: boolean;  // True when streaming.started event received (Telnyx)
  wsToken: string;  // Security token for WebSocket authentication
  conversationHistory: Array<{ speaker: 'claude' | 'user'; message: string }>;
  startTime: number;
  hungUp: boolean;
  sttSession: RealtimeSTTSession | null;
}

interface InboundCallState {
  callId: string;
  callControlId: string;
  fromNumber: string;
  ws: WebSocket | null;
  streamSid: string | null;
  streamingReady: boolean;
  wsToken: string;
  claudeSession: ClaudeSessionManager | null;
  sttSession: RealtimeSTTSession | null;
  conversationHistory: Array<{ speaker: 'caller' | 'claude'; message: string }>;
  startTime: number;
  hungUp: boolean;
}

type MediaCallState = Pick<CallState, 'callId' | 'ws' | 'streamSid' | 'streamingReady' | 'sttSession' | 'hungUp'>;

export interface ServerConfig {
  publicUrl: string;
  port: number;
  phoneNumber: string;
  userPhoneNumber: string;
  providers: ProviderRegistry;
  providerConfig: ProviderConfig;  // For webhook signature verification
  transcriptTimeoutMs: number;
  inboundEnabled: boolean;
  inboundWhitelist: string[];
  inboundWorkspaceDir: string;
  inboundPermissionMode: string;
  inboundMaxCalls: number;
  inboundGreeting: string;
}

export function loadServerConfig(publicUrl: string): ServerConfig {
  const providerConfig = loadProviderConfig();
  const errors = validateProviderConfig(providerConfig);

  if (!process.env.CALLME_USER_PHONE_NUMBER) {
    errors.push('Missing CALLME_USER_PHONE_NUMBER (where to call you)');
  }

  if (providerConfig.inboundEnabled && !providerConfig.inboundWorkspaceDir) {
    errors.push('Missing CALLME_WORKSPACE_DIR (required when inbound calls are enabled)');
  }

  if (errors.length > 0) {
    throw new Error(`Missing required configuration:\n  - ${errors.join('\n  - ')}`);
  }

  const providers = createProviders(providerConfig);

  // Default 3 minutes for transcript timeout
  const transcriptTimeoutMs = parseInt(process.env.CALLME_TRANSCRIPT_TIMEOUT_MS || '180000', 10);

  return {
    publicUrl,
    port: parseInt(process.env.CALLME_PORT || '3333', 10),
    phoneNumber: providerConfig.phoneNumber,
    userPhoneNumber: process.env.CALLME_USER_PHONE_NUMBER!,
    providers,
    providerConfig,
    transcriptTimeoutMs,
    inboundEnabled: providerConfig.inboundEnabled,
    inboundWhitelist: providerConfig.inboundWhitelist,
    inboundWorkspaceDir: providerConfig.inboundWorkspaceDir,
    inboundPermissionMode: providerConfig.inboundPermissionMode,
    inboundMaxCalls: providerConfig.inboundMaxCalls,
    inboundGreeting: providerConfig.inboundGreeting,
  };
}

export class CallManager {
  private activeCalls = new Map<string, CallState>();
  private inboundCalls = new Map<string, InboundCallState>();
  private callControlIdToCallId = new Map<string, string>();
  private wsTokenToCallId = new Map<string, string>();  // For WebSocket auth
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private config: ServerConfig;
  private currentCallId = 0;
  private currentInboundCallId = 0;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  private isWhitelisted(phoneNumber: string): boolean {
    const whitelist = new Set([
      this.config.userPhoneNumber,
      ...this.config.inboundWhitelist,
    ]);
    return whitelist.has(phoneNumber);
  }

  private getTotalActiveCalls(): number {
    return this.activeCalls.size + this.inboundCalls.size;
  }

  private findInboundCallByControlId(callControlId: string): string | null {
    for (const [callId, state] of this.inboundCalls) {
      if (state.callControlId === callControlId) return callId;
    }
    return null;
  }

  startServer(): void {
    this.httpServer = createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (url.pathname === '/twiml') {
        this.handlePhoneWebhook(req, res);
        return;
      }

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', activeCalls: this.activeCalls.size, inboundCalls: this.inboundCalls.size }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (request: IncomingMessage, socket: any, head: Buffer) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      if (url.pathname === '/media-stream') {
        // Try to find the call ID from token
        const token = url.searchParams.get('token');
        let callId = token ? this.wsTokenToCallId.get(token) : null;

        // Validate token if provided
        if (token && callId) {
          const state = this.activeCalls.get(callId) || this.inboundCalls.get(callId);
          if (!state || !validateWebSocketToken(state.wsToken, token)) {
            console.error('[Security] Rejecting WebSocket: token validation failed');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          console.error(`[Security] WebSocket token validated for call ${callId}`);
        } else if (!callId) {
          // Token missing or not found - only allow fallback for ngrok free tier
          const isNgrokFreeTier = new URL(this.config.publicUrl).hostname.endsWith('.ngrok-free.app');
          if (isNgrokFreeTier) {
            // Fallback: find the most recent active call (ngrok compatibility mode)
            // Token lookup can fail due to timing issues with ngrok's free tier
            const activeCallIds = Array.from(this.activeCalls.keys());
            if (activeCallIds.length > 0) {
              callId = activeCallIds[activeCallIds.length - 1];
              console.error(`[WebSocket] Token not found, using fallback call ID: ${callId} (ngrok compatibility mode)`);
            } else {
              // No active calls yet - create a placeholder and accept anyway
              // The connection handler will associate it with the correct call
              callId = `pending-${Date.now()}`;
              console.error(`[WebSocket] No active calls, using placeholder: ${callId} (ngrok compatibility mode)`);
            }
          } else {
            console.error('[Security] Rejecting WebSocket: missing or invalid token');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
        }

        // Accept WebSocket connection
        console.error(`[WebSocket] Accepting connection for: ${callId}`);
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request, callId);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket, _request: IncomingMessage, callId: string) => {
      console.error(`Media stream WebSocket connected for call ${callId}`);

      // Associate the WebSocket with the call immediately (token already validated)
      const state = this.activeCalls.get(callId) || this.inboundCalls.get(callId);
      if (state) {
        state.ws = ws;
      }

      ws.on('message', (message: Buffer | string) => {
        const msgBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message);

        // Parse JSON messages from Twilio to capture streamSid and handle events
        if (msgBuffer.length > 0 && msgBuffer[0] === 0x7b) {
          try {
            const msg = JSON.parse(msgBuffer.toString());
            const msgState = this.activeCalls.get(callId) || this.inboundCalls.get(callId);

            // Capture streamSid from "start" event (required for sending audio back)
            // Support both Twilio (streamSid) and ClawOps (start.streamId / start.streamSid)
            const capturedStreamSid = msg.streamSid || msg.start?.streamSid || msg.start?.streamId;
            if (msg.event === 'start' && capturedStreamSid && msgState) {
              msgState.streamSid = capturedStreamSid;
              console.error(`[${callId}] Captured streamSid: ${capturedStreamSid}`);
              if (msg.start?.mediaFormat) {
                console.error(`[${callId}] Media format: ${JSON.stringify(msg.start.mediaFormat)}`);
              }
            }

            // Handle "stop" event when call ends
            if (msg.event === 'stop' && msgState) {
              console.error(`[${callId}] Stream stopped`);
              msgState.hungUp = true;
            }
          } catch { }
        }

        // Forward audio to realtime transcription session
        const audioState = this.activeCalls.get(callId) || this.inboundCalls.get(callId);
        if (audioState?.sttSession) {
          const audioData = this.extractInboundAudio(msgBuffer);
          if (audioData) {
            audioState.sttSession.sendAudio(audioData);
          }
        }
      });

      ws.on('close', () => {
        console.error('Media stream WebSocket closed');
      });
    });

    this.httpServer.listen(this.config.port, () => {
      console.error(`HTTP server listening on port ${this.config.port}`);
    });
  }

  /**
   * Extract INBOUND audio data from WebSocket message (filters out outbound/TTS audio)
   */
  private extractInboundAudio(msgBuffer: Buffer): Buffer | null {
    if (msgBuffer.length === 0) return null;

    // Binary audio (doesn't start with '{') - can't determine track, skip
    if (msgBuffer[0] !== 0x7b) {
      return null;
    }

    // JSON format - only extract inbound track (user's voice)
    try {
      const msg = JSON.parse(msgBuffer.toString());
      if (msg.event === 'media' && msg.media?.payload) {
        const track = msg.media?.track;
        if (track === 'inbound' || track === 'inbound_track') {
          return Buffer.from(msg.media.payload, 'base64');
        }
      }
    } catch { }

    return null;
  }

  private handlePhoneWebhook(req: IncomingMessage, res: ServerResponse): void {
    const contentType = req.headers['content-type'] || '';

    // Telnyx sends JSON webhooks
    if (contentType.includes('application/json')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          // Validate Telnyx signature if public key is configured
          const telnyxPublicKey = this.config.providerConfig.telnyxPublicKey;
          if (telnyxPublicKey) {
            const signature = req.headers['telnyx-signature-ed25519'] as string | undefined;
            const timestamp = req.headers['telnyx-timestamp'] as string | undefined;

            if (!validateTelnyxSignature(telnyxPublicKey, signature, timestamp, body)) {
              console.error('[Security] Rejecting Telnyx webhook: invalid signature');
              res.writeHead(401);
              res.end('Invalid signature');
              return;
            }
          } else {
            console.error('[Security] Warning: CALLME_TELNYX_PUBLIC_KEY not set, skipping signature verification');
          }

          const event = JSON.parse(body);
          await this.handleTelnyxWebhook(event, res);
        } catch (error) {
          console.error('Error parsing webhook:', error);
          res.writeHead(400);
          res.end('Invalid JSON');
        }
      });
      return;
    }

    // Twilio sends form-urlencoded webhooks
    if (contentType.includes('application/x-www-form-urlencoded')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const params = new URLSearchParams(body);

          // Validate webhook signature (Twilio: x-twilio-signature, ClawOps: x-signature)
          // ClawOps uses a dedicated signing key; Twilio uses auth token for both API and signing
          const isClawOps = this.config.providerConfig.phoneProvider === 'clawops';
          const authToken = isClawOps
            ? (this.config.providerConfig.phoneSigningKey || '')
            : this.config.providerConfig.phoneAuthToken;
          const signature = isClawOps
            ? req.headers['x-signature'] as string | undefined
            : req.headers['x-twilio-signature'] as string | undefined;
          // Use the known public URL directly - reconstructing from headers fails with ngrok
          // because ngrok doesn't preserve headers exactly as Twilio sends them
          const webhookUrl = `${this.config.publicUrl}/twiml`;

          if (!validateTwilioSignature(authToken, signature, webhookUrl, params)) {
            const isNgrokFreeTier = new URL(this.config.publicUrl).hostname.endsWith('.ngrok-free.app');
            if (isNgrokFreeTier) {
              // Only log if ngrok free tier is used
              // Log for debugging but proceed anyway - ngrok free tier causes signature mismatches
              console.error('[Security] Webhook signature validation failed (proceeding anyway for ngrok compatibility)');
            } else {
              console.error(`[Security] Rejecting ${isClawOps ? 'ClawOps' : 'Twilio'} webhook: invalid signature`);
              res.writeHead(401);
              res.end('Invalid signature');
              return;
            }
          }

          await this.handleTwilioWebhook(params, res);
        } catch (error) {
          console.error('Error parsing Twilio webhook:', error);
          res.writeHead(400);
          res.end('Invalid form data');
        }
      });
      return;
    }

    // Fallback: Reject unknown content types
    console.error('[Security] Rejecting webhook with unknown content type:', contentType);
    res.writeHead(400);
    res.end('Invalid content type');
  }

  private async handleTwilioWebhook(params: URLSearchParams, res: ServerResponse): Promise<void> {
    // Support both Twilio (CallSid) and ClawOps (CallId) field names
    const callSid = params.get('CallSid') || params.get('CallId');
    const callStatus = params.get('CallStatus');
    const fromNumber = params.get('From') || params.get('Caller') || '';
    const direction = params.get('Direction') || '';

    console.error(`Phone webhook: CallSid=${callSid}, CallStatus=${callStatus}, From=${fromNumber}, Direction=${direction}`);

    // Handle call status updates (for both outbound and inbound)
    if (callStatus === 'completed' || callStatus === 'busy' || callStatus === 'no-answer' || callStatus === 'failed') {
      if (callSid) {
        // Check outbound calls
        const callId = this.callControlIdToCallId.get(callSid);
        if (callId) {
          this.callControlIdToCallId.delete(callSid);
          const state = this.activeCalls.get(callId);
          if (state) {
            state.hungUp = true;
            state.ws?.close();
          }
        }
        // Check inbound calls
        const inboundCallId = this.findInboundCallByControlId(callSid);
        if (inboundCallId) {
          const inboundState = this.inboundCalls.get(inboundCallId);
          if (inboundState) {
            inboundState.hungUp = true;
            inboundState.ws?.close();
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }

    // Check if this is a known outbound call
    if (callSid && this.callControlIdToCallId.has(callSid)) {
      // Outbound call: return TwiML to start media stream
      let streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;
      const callId = this.callControlIdToCallId.get(callSid)!;
      const state = this.activeCalls.get(callId);
      if (state) {
        streamUrl += `?token=${encodeURIComponent(state.wsToken)}`;
      }

      const xml = this.config.providers.phone.getStreamConnectXml(streamUrl);
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(xml);
      return;
    }

    // Unknown call → treat as inbound
    if (!this.config.inboundEnabled) {
      console.error(`[inbound] Rejecting Twilio call: inbound disabled`);
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      return;
    }
    if (!this.isWhitelisted(fromNumber)) {
      console.error(`[inbound] Rejecting Twilio call from ${fromNumber}: not in whitelist`);
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      return;
    }
    if (this.getTotalActiveCalls() >= this.config.inboundMaxCalls) {
      console.error(`[inbound] Rejecting Twilio call: max calls reached`);
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      return;
    }

    if (!callSid) {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      return;
    }

    await this.handleInboundTwilioCall(callSid, fromNumber, res);
  }

  private async handleInboundTwilioCall(callSid: string, fromNumber: string, res: ServerResponse): Promise<void> {
    const callId = `inbound-${++this.currentInboundCallId}-${Date.now()}`;
    const wsToken = generateWebSocketToken();

    console.error(`[inbound] Accepting call ${callId} from ${fromNumber}`);

    const sttSession = this.config.providers.stt.createSession();
    await sttSession.connect();

    const state: InboundCallState = {
      callId,
      callControlId: callSid,
      fromNumber,
      ws: null,
      streamSid: null,
      streamingReady: false,
      wsToken,
      claudeSession: null,
      sttSession,
      conversationHistory: [],
      startTime: Date.now(),
      hungUp: false,
    };

    this.inboundCalls.set(callId, state);
    this.wsTokenToCallId.set(wsToken, callId);

    const streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream?token=${encodeURIComponent(wsToken)}`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);

    // Start conversation loop asynchronously
    this.runInboundConversation(callId).finally(() => {
      this.cleanupInboundCall(callId).catch(console.error);
    });
  }

  private async handleTelnyxWebhook(event: any, res: ServerResponse): Promise<void> {
    const eventType = event.data?.event_type;
    const callControlId = event.data?.payload?.call_control_id;

    console.error(`Phone webhook: ${eventType}`);

    // Always respond 200 OK immediately
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));

    if (!callControlId) return;

    try {
      switch (eventType) {
        case 'call.initiated': {
          const direction = event.data?.payload?.direction;
          if (direction === 'incoming' && !this.callControlIdToCallId.has(callControlId)) {
            const fromNumber = event.data?.payload?.from || '';
            await this.handleInboundTelnyxCall(callControlId, fromNumber);
          }
          break;
        }

        case 'call.answered': {
          // Include security token in the stream URL
          let streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;
          const callId = this.callControlIdToCallId.get(callControlId);
          if (callId) {
            const state = this.activeCalls.get(callId);
            if (state) {
              streamUrl += `?token=${encodeURIComponent(state.wsToken)}`;
            }
          } else {
            // Check inbound calls
            const inboundCallId = this.findInboundCallByControlId(callControlId);
            if (inboundCallId) {
              const inboundState = this.inboundCalls.get(inboundCallId);
              if (inboundState) {
                streamUrl += `?token=${encodeURIComponent(inboundState.wsToken)}`;
              }
            }
          }
          await this.config.providers.phone.startStreaming(callControlId, streamUrl);
          console.error(`Started streaming for call ${callControlId}`);
          break;
        }

        case 'call.hangup': {
          const hangupCallId = this.callControlIdToCallId.get(callControlId);
          if (hangupCallId) {
            this.callControlIdToCallId.delete(callControlId);
            const hangupState = this.activeCalls.get(hangupCallId);
            if (hangupState) {
              hangupState.hungUp = true;
              hangupState.ws?.close();
            }
          }
          // Check inbound calls
          const inboundHangupCallId = this.findInboundCallByControlId(callControlId);
          if (inboundHangupCallId) {
            const inboundState = this.inboundCalls.get(inboundHangupCallId);
            if (inboundState) {
              inboundState.hungUp = true;
              // ws.close() will be handled by cleanupInboundCall
            }
          }
          break;
        }

        case 'call.machine.detection.ended': {
          const result = event.data?.payload?.result;
          console.error(`AMD result: ${result}`);
          break;
        }

        case 'streaming.started': {
          const streamCallId = this.callControlIdToCallId.get(callControlId);
          if (streamCallId) {
            const streamState = this.activeCalls.get(streamCallId);
            if (streamState) {
              streamState.streamingReady = true;
              console.error(`[${streamCallId}] Streaming ready`);
            }
          }
          // Check inbound calls
          const inboundStreamCallId = this.findInboundCallByControlId(callControlId);
          if (inboundStreamCallId) {
            const inboundStreamState = this.inboundCalls.get(inboundStreamCallId);
            if (inboundStreamState) {
              inboundStreamState.streamingReady = true;
              console.error(`[${inboundStreamCallId}] Streaming ready`);
            }
          }
          break;
        }

        case 'streaming.stopped':
          break;
      }
    } catch (error) {
      console.error(`Error handling webhook ${eventType}:`, error);
    }
  }

  private async handleInboundTelnyxCall(callControlId: string, fromNumber: string): Promise<void> {
    if (!this.config.inboundEnabled) {
      console.error(`[inbound] Rejecting Telnyx call: inbound disabled`);
      await this.config.providers.phone.hangup(callControlId);
      return;
    }
    if (!this.isWhitelisted(fromNumber)) {
      console.error(`[inbound] Rejecting Telnyx call from ${fromNumber}: not in whitelist`);
      await this.config.providers.phone.hangup(callControlId);
      return;
    }
    if (this.getTotalActiveCalls() >= this.config.inboundMaxCalls) {
      console.error(`[inbound] Rejecting Telnyx call: max calls reached`);
      await this.config.providers.phone.hangup(callControlId);
      return;
    }

    const callId = `inbound-${++this.currentInboundCallId}-${Date.now()}`;
    const wsToken = generateWebSocketToken();
    console.error(`[inbound] Accepting Telnyx call ${callId} from ${fromNumber}`);

    const sttSession = this.config.providers.stt.createSession();
    await sttSession.connect();

    const state: InboundCallState = {
      callId, callControlId, fromNumber,
      ws: null, streamSid: null, streamingReady: false, wsToken,
      claudeSession: null, sttSession,
      conversationHistory: [], startTime: Date.now(), hungUp: false,
    };

    this.inboundCalls.set(callId, state);
    this.wsTokenToCallId.set(wsToken, callId);

    // Answer the inbound Telnyx call
    try {
      const config = this.config.providerConfig;
      const response = await fetch(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.phoneAuthToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        }
      );
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Telnyx answer failed: ${response.status} ${error}`);
      }
    } catch (err) {
      console.error(`[inbound] Failed to answer Telnyx call ${callId}:`, err);
      this.cleanupInboundCall(callId).catch(console.error);
      return;
    }

    this.runInboundConversation(callId).finally(() => {
      this.cleanupInboundCall(callId).catch(console.error);
    });
  }

  async initiateCall(clientId: string, message: string): Promise<{ callId: string; response: string }> {
    if (this.getTotalActiveCalls() > 0) {
      throw new CallConflictError('A call is already in progress');
    }
    const callId = `call-${++this.currentCallId}-${Date.now()}`;

    // Create realtime transcription session via provider
    const sttSession = this.config.providers.stt.createSession();
    await sttSession.connect();
    console.error(`[${callId}] STT session connected`);

    // Generate secure token for WebSocket authentication
    const wsToken = generateWebSocketToken();

    const state: CallState = {
      callId,
      ownerClientId: clientId,
      callControlId: null,
      userPhoneNumber: this.config.userPhoneNumber,
      ws: null,
      streamSid: null,
      streamingReady: false,
      wsToken,
      conversationHistory: [],
      startTime: Date.now(),
      hungUp: false,
      sttSession,
    };

    this.activeCalls.set(callId, state);

    try {
      const callControlId = await this.config.providers.phone.initiateCall(
        this.config.userPhoneNumber,
        this.config.phoneNumber,
        `${this.config.publicUrl}/twiml`
      );

      state.callControlId = callControlId;
      this.callControlIdToCallId.set(callControlId, callId);
      this.wsTokenToCallId.set(wsToken, callId);

      console.error(`Call initiated: ${callControlId} -> ${this.config.userPhoneNumber}`);

      // Start TTS generation in parallel with waiting for connection
      // This reduces latency by generating audio while Twilio establishes the stream
      const ttsPromise = this.generateTTSAudio(message);

      await this.waitForConnection(callId, 15000);

      // Send the pre-generated audio and listen for response
      const audioData = await ttsPromise;
      await this.sendPreGeneratedAudio(state, audioData);
      const response = await this.listen(state);
      state.conversationHistory.push({ speaker: 'claude', message });
      state.conversationHistory.push({ speaker: 'user', message: response });

      return { callId, response };
    } catch (error) {
      state.sttSession?.close();
      this.activeCalls.delete(callId);
      throw error;
    }
  }

  async continueCall(clientId: string, callId: string, message: string): Promise<string> {
    const state = this.activeCalls.get(callId);
    if (!state) throw new Error(`No active call: ${callId}`);
    if (state.ownerClientId !== clientId) throw new CallForbiddenError('Not the call owner');

    const response = await this.speakAndListen(state, message);
    state.conversationHistory.push({ speaker: 'claude', message });
    state.conversationHistory.push({ speaker: 'user', message: response });

    return response;
  }

  async speakOnly(clientId: string, callId: string, message: string): Promise<void> {
    const state = this.activeCalls.get(callId);
    if (!state) throw new Error(`No active call: ${callId}`);
    if (state.ownerClientId !== clientId) throw new CallForbiddenError('Not the call owner');

    await this.speak(state, message);
    state.conversationHistory.push({ speaker: 'claude', message });
  }

  async endCall(clientId: string, callId: string, message: string): Promise<{ durationSeconds: number }> {
    const state = this.activeCalls.get(callId);
    if (!state) throw new Error(`No active call: ${callId}`);
    if (state.ownerClientId !== clientId) throw new CallForbiddenError('Not the call owner');

    await this.speak(state, message);

    // Wait for audio to finish playing before hanging up (prevent cutoff)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Hang up the call via phone provider
    if (state.callControlId) {
      await this.config.providers.phone.hangup(state.callControlId);
    }

    // Close sessions and clean up mappings
    state.sttSession?.close();
    state.ws?.close();
    state.hungUp = true;

    // Clean up security token mapping
    this.wsTokenToCallId.delete(state.wsToken);
    if (state.callControlId) {
      this.callControlIdToCallId.delete(state.callControlId);
    }

    const durationSeconds = Math.round((Date.now() - state.startTime) / 1000);
    this.activeCalls.delete(callId);

    return { durationSeconds };
  }

  async forceEndCallByClient(clientId: string): Promise<void> {
    const callIds = Array.from(this.activeCalls.entries())
      .filter(([, state]) => state.ownerClientId === clientId)
      .map(([callId]) => callId);
    for (const callId of callIds) {
      try {
        await this.endCall(clientId, callId, 'Connection lost. Goodbye.');
      } catch { /* ignore errors during forced cleanup */ }
    }
  }

  private async waitForConnection(callId: string, timeout: number): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const state = this.activeCalls.get(callId);
      // Wait for WebSocket AND streaming to be ready:
      // - Twilio: streamSid is set from "start" WebSocket event
      // - Telnyx: streamingReady is set from "streaming.started" webhook
      const wsReady = state?.ws && state.ws.readyState === WebSocket.OPEN;
      const streamReady = state?.streamSid || state?.streamingReady;
      if (wsReady && streamReady) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('WebSocket connection timeout');
  }

  /**
   * Pre-generate TTS audio (can run in parallel with connection setup)
   * Returns 24kHz PCM16 audio ready to send
   */
  private async generateTTSAudio(text: string): Promise<Buffer> {
    console.error(`[TTS] Generating audio for: ${text.substring(0, 50)}...`);
    const tts = this.config.providers.tts;
    const pcmData = await tts.synthesize(text);
    console.error(`[TTS] Audio generated: ${pcmData.length} bytes`);
    return pcmData;
  }

  /**
   * Send a single audio chunk to the phone via WebSocket
   */
  private sendMediaChunk(state: MediaCallState, audioData: Buffer): void {
    if (state.ws?.readyState !== WebSocket.OPEN) return;
    const message: Record<string, unknown> = {
      event: 'media',
      media: { payload: audioData.toString('base64') },
    };
    if (state.streamSid) {
      message.streamSid = state.streamSid;
    }
    state.ws.send(JSON.stringify(message));
  }

  private async sendPreGeneratedAudio(state: MediaCallState, pcmData: Buffer): Promise<void> {
    console.error(`[${state.callId}] Sending pre-generated audio...`);
    const chunkSize = 960;  // 20ms at 24kHz PCM16
    for (let i = 0; i < pcmData.length; i += chunkSize) {
      this.sendMediaChunk(state, pcmData.subarray(i, i + chunkSize));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Small delay to ensure audio finishes playing before listening
    await new Promise((resolve) => setTimeout(resolve, 200));
    console.error(`[${state.callId}] Audio sent`);
  }

  private async speakAndListen(state: MediaCallState, text: string): Promise<string> {
    await this.speak(state, text);
    return await this.listen(state);
  }

  private async speak(state: MediaCallState, text: string): Promise<void> {
    console.error(`[${state.callId}] Speaking: ${text.substring(0, 50)}...`);

    const tts = this.config.providers.tts;

    // Use streaming if available for lower latency
    if (tts.synthesizeStream) {
      await this.speakStreaming(state, text, tts.synthesizeStream.bind(tts));
    } else {
      const pcmData = await tts.synthesize(text);
      await this.sendAudio(state, pcmData);
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
    console.error(`[${state.callId}] Speaking done`);
  }

  private async speakStreaming(
    state: MediaCallState,
    text: string,
    synthesizeStream: (text: string) => AsyncGenerator<Buffer>
  ): Promise<void> {
    let outputBuffer = Buffer.alloc(0);
    const OUTPUT_CHUNK_SIZE = 960;         // 20ms at 24kHz PCM16
    const JITTER_BUFFER_MS = 100;
    const JITTER_BUFFER_SIZE = (24000 * 2 / 1000) * JITTER_BUFFER_MS; // 4800 bytes
    let playbackStarted = false;

    // Helper to drain and send buffered PCM audio in chunks
    const drainBuffer = async () => {
      while (outputBuffer.length >= OUTPUT_CHUNK_SIZE) {
        this.sendMediaChunk(state, outputBuffer.subarray(0, OUTPUT_CHUNK_SIZE));
        outputBuffer = outputBuffer.subarray(OUTPUT_CHUNK_SIZE);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    for await (const chunk of synthesizeStream(text)) {
      outputBuffer = Buffer.concat([outputBuffer, chunk]);

      // Wait for jitter buffer to fill before starting playback
      if (!playbackStarted && outputBuffer.length < JITTER_BUFFER_SIZE) {
        continue;
      }
      playbackStarted = true;

      await drainBuffer();
    }

    // Send remaining audio (including any buffered audio for short messages)
    await drainBuffer();

    // Send any final partial chunk
    if (outputBuffer.length > 0) {
      this.sendMediaChunk(state, outputBuffer);
    }
  }

  private async sendAudio(state: MediaCallState, pcmData: Buffer): Promise<void> {
    const chunkSize = 960;  // 20ms at 24kHz PCM16
    for (let i = 0; i < pcmData.length; i += chunkSize) {
      this.sendMediaChunk(state, pcmData.subarray(i, i + chunkSize));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async listen(state: MediaCallState): Promise<string> {
    console.error(`[${state.callId}] Listening...`);

    if (!state.sttSession) {
      throw new Error('STT session not available');
    }

    // Race between getting a transcript and detecting hangup
    const transcript = await Promise.race([
      state.sttSession.waitForTranscript(this.config.transcriptTimeoutMs),
      this.waitForHangup(state),
    ]);

    if (state.hungUp) {
      throw new Error('Call was hung up by user');
    }

    console.error(`[${state.callId}] User said: ${transcript}`);
    return transcript;
  }

  /**
   * Returns a promise that rejects when the call is hung up.
   * Used to race against transcript waiting.
   */
  private waitForHangup(state: MediaCallState): Promise<never> {
    return new Promise((_, reject) => {
      const checkInterval = setInterval(() => {
        if (state.hungUp) {
          clearInterval(checkInterval);
          reject(new Error('Call was hung up by user'));
        }
      }, 100);  // Check every 100ms

      // Clean up interval after transcript timeout to avoid memory leaks
      setTimeout(() => {
        clearInterval(checkInterval);
      }, this.config.transcriptTimeoutMs + 1000);
    });
  }

  private async runInboundConversation(callId: string): Promise<void> {
    const state = this.inboundCalls.get(callId);
    if (!state) return;

    // Wait for connection
    await this.waitForInboundConnection(callId, 15000);

    // Send greeting
    await this.speak(state, this.config.inboundGreeting);

    // Init Claude session
    const claudeSession = new ClaudeSessionManager({
      workspaceDir: this.config.inboundWorkspaceDir,
      permissionMode: this.config.inboundPermissionMode,
      timeoutMs: this.config.transcriptTimeoutMs,
    });
    state.claudeSession = claudeSession;

    // Conversation loop
    while (!state.hungUp) {
      try {
        const userMessage = await this.listen(state);
        if (state.hungUp) break;

        state.conversationHistory.push({ speaker: 'caller', message: userMessage });
        console.error(`[${callId}] Caller said: ${userMessage}`);

        const claudeResponse = await Promise.race([
          claudeSession.sendMessage(userMessage),
          new Promise<never>((_, reject) => {
            const check = setInterval(() => {
              if (state.hungUp) {
                clearInterval(check);
                reject(new Error('Call was hung up by user'));
              }
            }, 500);
            // Safety cleanup after timeout
            setTimeout(() => clearInterval(check), this.config.transcriptTimeoutMs);
          }),
        ]);
        if (state.hungUp) break;

        state.conversationHistory.push({ speaker: 'claude', message: claudeResponse });
        console.error(`[${callId}] Claude says: ${claudeResponse.substring(0, 100)}...`);

        await this.speak(state, claudeResponse);
      } catch (error) {
        if (state.hungUp) break;
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[${callId}] Conversation loop error: ${msg}`);
        if (msg.includes('hung up')) break;

        try {
          await this.speak(state, '죄송합니다. 오류가 발생했습니다. 다시 말씀해주세요.');
        } catch { break; }
      }
    }

    console.error(`[${callId}] Conversation ended`);
  }

  private async waitForInboundConnection(callId: string, timeout: number): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const state = this.inboundCalls.get(callId);
      if (!state) throw new Error('Inbound call state not found');
      if (state.hungUp) throw new Error('Call was hung up');
      const wsReady = state.ws && state.ws.readyState === WebSocket.OPEN;
      const streamReady = state.streamSid || state.streamingReady;
      if (wsReady && streamReady) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Inbound WebSocket connection timeout');
  }

  async cleanupInboundCall(callId: string): Promise<void> {
    const state = this.inboundCalls.get(callId);
    if (!state) return;

    console.error(`[${callId}] Cleaning up inbound call`);
    state.hungUp = true;
    state.sttSession?.close();
    state.claudeSession?.dispose();
    state.ws?.close();
    this.wsTokenToCallId.delete(state.wsToken);

    if (state.callControlId) {
      try { await this.config.providers.phone.hangup(state.callControlId); } catch { /* ignore */ }
    }

    const durationSeconds = Math.round((Date.now() - state.startTime) / 1000);
    console.error(`[${callId}] Inbound call ended. Duration: ${durationSeconds}s, Turns: ${state.conversationHistory.length}`);
    this.inboundCalls.delete(callId);
  }

  getHttpServer() {
    return this.httpServer;
  }

  shutdown(): void {
    for (const [callId, state] of this.activeCalls) {
      this.endCall(state.ownerClientId, callId, 'Goodbye!').catch(console.error);
    }
    for (const callId of this.inboundCalls.keys()) {
      this.cleanupInboundCall(callId).catch(console.error);
    }
    this.wss?.close();
    this.httpServer?.close();
  }
}
