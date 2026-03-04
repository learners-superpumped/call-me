/**
 * Callio Phone Provider
 *
 * Uses sip-ai-callbot CPaaS Voice API (Twilio-compatible).
 * Credentials: accountId (CALLME_PHONE_ACCOUNT_SID) + authToken (CALLME_PHONE_AUTH_TOKEN)
 * Base URL: CALLME_CALLIO_BASE_URL (default: https://sip.clawops.io:3000)
 */

import type { PhoneProvider, PhoneConfig } from './types.js';

export class CallioPhoneProvider implements PhoneProvider {
  readonly name = 'callio';
  private accountId: string | null = null;
  private authToken: string | null = null;
  private baseUrl: string = process.env.CALLME_CALLIO_BASE_URL || 'https://sip.clawops.io:3000';

  initialize(config: PhoneConfig): void {
    this.accountId = config.accountSid;
    this.authToken = config.authToken;
    console.error(`Phone provider: Callio (${this.baseUrl})`);
  }

  private get authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.accountId}:${this.authToken}`).toString('base64');
  }

  async initiateCall(to: string, from: string, webhookUrl: string): Promise<string> {
    if (!this.accountId || !this.authToken) {
      throw new Error('Callio provider not initialized');
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
      throw new Error(`Callio call failed: ${response.status} ${error}`);
    }

    const data = await response.json() as { callId: string };
    return data.callId;
  }

  async hangup(callControlId: string): Promise<void> {
    if (!this.accountId || !this.authToken) {
      throw new Error('Callio provider not initialized');
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
      console.error(`Callio hangup failed: ${response.status} ${error}`);
    }
  }

  /**
   * Callio starts streaming via TwiML response (same as Twilio) — no-op
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
