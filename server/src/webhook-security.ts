/**
 * Webhook Security - Signature verification for ClawOps webhooks
 *
 * Prevents unauthorized requests to webhook endpoints by validating
 * HMAC-SHA1 cryptographic signatures.
 */

import { createHmac } from 'crypto';

/**
 * Validate webhook signature (HMAC-SHA1)
 *
 * Algorithm:
 * 1. Take the full URL (as the caller sees it)
 * 2. Sort POST parameters alphabetically
 * 3. Append each param name+value to URL (no delimiters)
 * 4. HMAC-SHA1 sign with signing key
 * 5. Base64 encode and compare
 */
export function validateWebhookSignature(
  signingKey: string,
  signature: string | undefined,
  url: string,
  params: URLSearchParams
): boolean {
  if (!signature) {
    console.error('[Security] Missing webhook signature header');
    return false;
  }

  // Build the string to sign: URL + sorted params
  let dataToSign = url;

  // Sort params alphabetically and append name+value
  const sortedParams = Array.from(params.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  for (const [key, value] of sortedParams) {
    dataToSign += key + value;
  }

  // HMAC-SHA1 with signing key, then base64 encode
  const expectedSignature = createHmac('sha1', signingKey)
    .update(dataToSign)
    .digest('base64');

  const valid = signature === expectedSignature;

  if (!valid) {
    console.error('[Security] Webhook signature mismatch');
    console.error(`[Security] Expected: ${expectedSignature}`);
    console.error(`[Security] Received: ${signature}`);
  }

  return valid;
}

/**
 * Generate a secure random token for WebSocket authentication
 */
export function generateWebSocketToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Validate a WebSocket token from the URL
 */
export function validateWebSocketToken(
  expectedToken: string,
  receivedToken: string | undefined
): boolean {
  if (!receivedToken) {
    console.error('[Security] Missing WebSocket token');
    return false;
  }

  // Use timing-safe comparison to prevent timing attacks
  if (expectedToken.length !== receivedToken.length) {
    console.error('[Security] WebSocket token length mismatch');
    return false;
  }

  let result = 0;
  for (let i = 0; i < expectedToken.length; i++) {
    result |= expectedToken.charCodeAt(i) ^ receivedToken.charCodeAt(i);
  }

  const valid = result === 0;
  if (!valid) {
    console.error('[Security] WebSocket token mismatch');
  }

  return valid;
}
