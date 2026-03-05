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

      // Start initial shutdown timer in case no client ever connects
      this.config.onRefCountZero();
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

      const callMatch = url.pathname.match(/^\/calls\/([^/]+)\/(continue|speak|end)$/);
      if (method === 'POST' && callMatch) {
        const [, callId, action] = callMatch;
        return await this.handleCallAction(req, res, callId, action);
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      console.error('[daemon-api] Unhandled error:', error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
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
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { clientId } = body as { clientId: string };
    await this.removeClient(clientId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private async handleHeartbeat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { clientId } = body as { clientId: string };
    const client = this.clients.get(clientId);
    if (client) {
      client.lastHeartbeat = Date.now();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private async handleInitiateCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { clientId, message } = body as { clientId: string; message: string };

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
        const msg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[daemon-api] Call error:', msg);
        res.writeHead(500);
        res.end(JSON.stringify({ error: msg }));
      }
    }
  }

  private async handleCallAction(
    req: IncomingMessage, res: ServerResponse,
    callId: string, action: string
  ): Promise<void> {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { clientId, message } = body as { clientId: string; message: string };

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
        const msg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[daemon-api] Call error:', msg);
        res.writeHead(500);
        res.end(JSON.stringify({ error: msg }));
      }
    }
  }

  private async removeClient(clientId: string): Promise<void> {
    if (!this.clients.has(clientId)) return;
    await this.config.callManager.forceEndCallByClient(clientId);
    this.clients.delete(clientId);
    console.error(`[daemon] Client disconnected: ${clientId} (total: ${this.clients.size})`);
    if (this.clients.size === 0) {
      this.config.onRefCountZero();
    }
  }

  private async checkDeadClients(): Promise<void> {
    const now = Date.now();
    const deadTimeout = 10000;
    const deadClientIds: string[] = [];
    for (const [clientId, info] of this.clients) {
      if (now - info.lastHeartbeat > deadTimeout) {
        deadClientIds.push(clientId);
      }
    }
    for (const clientId of deadClientIds) {
      console.error(`[daemon] Client ${clientId} heartbeat timeout, removing`);
      await this.removeClient(clientId);
    }
  }
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        res.writeHead(413);
        res.end(JSON.stringify({ error: 'Request body too large' }));
        resolve(null);
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}
