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
