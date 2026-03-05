#!/usr/bin/env bun

import { CallManager, loadServerConfig, type ServerConfig } from './phone-call.js';
import { startNgrok, stopNgrok } from './ngrok.js';
import { DaemonApi } from './daemon-api.js';
import { writePidFile, writeControlPort, cleanupPidFile } from './daemon-lifecycle.js';

async function registerInboundWebhook(config: ServerConfig, publicUrl: string) {
  if (config.providerConfig.phoneProvider !== 'clawops') {
    console.error('[daemon] Webhook auto-registration is only supported for ClawOps provider');
    return;
  }

  const { phoneAccountSid, phoneApiKey, phoneNumber } = config.providerConfig;
  const baseUrl = process.env.CALLME_CLAWOPS_BASE_URL || 'https://api.claw-ops.com';
  const webhookUrl = `${publicUrl}/twiml`;

  try {
    const res = await fetch(`${baseUrl}/v1/accounts/${phoneAccountSid}/numbers/${phoneNumber}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${phoneApiKey}`,
      },
      body: JSON.stringify({ webhookUrl, webhookMethod: 'POST' }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[daemon] Failed to register webhook (${res.status}): ${body}`);
      return;
    }

    console.error(`[daemon] Registered inbound webhook: ${webhookUrl}`);
  } catch (error) {
    console.error('[daemon] Failed to register webhook:', error instanceof Error ? error.message : error);
  }
}

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
  const serverConfig = loadServerConfig(publicUrl);
  const callManager = new CallManager(serverConfig);
  callManager.startServer();

  // Auto-register webhook URL with phone provider for inbound calls
  if (serverConfig.inboundEnabled) {
    await registerInboundWebhook(serverConfig, publicUrl);
  }

  // Auto-shutdown timer
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  const SHUTDOWN_GRACE_MS = 30000;

  const shutdown = async () => {
    console.error('[daemon] Shutting down...');
    daemonApi.shutdown();
    callManager.shutdown();
    await stopNgrok();
    cleanupPidFile();
    process.exit(0);
  };

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
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[daemon] Fatal error:', error);
  cleanupPidFile();
  process.exit(1);
});
