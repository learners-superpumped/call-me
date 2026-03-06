/**
 * ClawOps Phone Provider
 *
 * Uses ClawOps CPaaS Voice API.
 * Credentials:
 *   - accountId (CALLME_PHONE_ACCOUNT_SID): Account ID (AC...)
 *   - apiKey (CALLME_PHONE_API_KEY): Bearer token for API calls (sk_...)
 *   - signingKey (CALLME_PHONE_SIGNING_KEY): Webhook signature verification
 * Base URL: CALLME_CLAWOPS_BASE_URL (default: https://api.claw-ops.com)
 */

import type { PhoneProvider, PhoneConfig } from './types.js';

export class ClawOpsPhoneProvider implements PhoneProvider {
  readonly name = 'clawops';
  private accountId: string | null = null;
  private apiKey: string | null = null;
  private baseUrl: string = process.env.CALLME_CLAWOPS_BASE_URL || 'https://api.claw-ops.com';

  initialize(config: PhoneConfig): void {
    this.accountId = config.accountSid;
    this.apiKey = config.apiKey;
    console.error(`Phone provider: ClawOps (${this.baseUrl})`);
  }

  private get authHeader(): string {
    return `Bearer ${this.apiKey}`;
  }

  async initiateCall(to: string, from: string, webhookUrl: string): Promise<string> {
    if (!this.accountId || !this.apiKey) {
      throw new Error('ClawOps provider not initialized');
    }

    const url = `${this.baseUrl}/v1/accounts/${this.accountId}/calls`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: to,
        From: from,
        Url: webhookUrl,
        StatusCallback: webhookUrl,
        StatusCallbackEvent: 'initiated ringing answered completed',
      }).toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ClawOps call failed: ${response.status} ${error}`);
    }

    const data = await response.json() as { callId: string };
    return data.callId;
  }

  async hangup(callControlId: string): Promise<void> {
    if (!this.accountId || !this.apiKey) {
      throw new Error('ClawOps provider not initialized');
    }

    const url = `${this.baseUrl}/v1/accounts/${this.accountId}/calls/${callControlId}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ Status: 'completed' }),
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      console.error(`ClawOps hangup failed: ${response.status} ${error}`);
    }
  }

  /**
   * ClawOps starts streaming via TwiML response — no-op
   */
  async startStreaming(_callControlId: string, _streamUrl: string): Promise<void> {}

  getStreamConnectXml(streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
  }
}
