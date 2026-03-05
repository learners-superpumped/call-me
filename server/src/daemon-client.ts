import { ensureDaemonRunning } from './daemon-lifecycle.js';

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

    // Start heartbeat every 5 seconds
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
    const data = await res.json();
    if (res.status === 409) throw new Error(data.error);
    if (!res.ok) throw new Error(data.error || `Daemon error: ${res.status}`);
    return data as { callId: string; response: string };
  }

  async continueCall(callId: string, message: string): Promise<string> {
    const res = await this.post(`/calls/${callId}/continue`, { clientId: this.clientId, message }, 300000);
    const data = await res.json() as { response?: string; error?: string };
    if (!res.ok) throw new Error(data.error || `Daemon error: ${res.status}`);
    return data.response!;
  }

  async speakOnly(callId: string, message: string): Promise<void> {
    const res = await this.post(`/calls/${callId}/speak`, { clientId: this.clientId, message }, 60000);
    if (!res.ok) {
      const data = await res.json() as { error: string };
      throw new Error(data.error || `Daemon error: ${res.status}`);
    }
  }

  async endCall(callId: string, message: string): Promise<{ durationSeconds: number }> {
    const res = await this.post(`/calls/${callId}/end`, { clientId: this.clientId, message }, 60000);
    const data = await res.json() as { durationSeconds?: number; error?: string };
    if (!res.ok) throw new Error(data.error || `Daemon error: ${res.status}`);
    return data as { durationSeconds: number };
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
