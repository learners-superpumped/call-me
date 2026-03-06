/**
 * Provider Factory
 *
 * Creates and configures providers. ClawOps for phone, OpenAI for TTS and Realtime STT.
 */

import type { PhoneProvider, TTSProvider, RealtimeSTTProvider, ProviderRegistry } from './types.js';
import { ClawOpsPhoneProvider } from './phone-clawops.js';
import { OpenAITTSProvider } from './tts-openai.js';
import { OpenAIRealtimeSTTProvider } from './stt-openai-realtime.js';

export * from './types.js';

export interface ProviderConfig {
  // ClawOps credentials
  // accountSid: Account ID (AC...)
  // phoneApiKey: API Key for API calls (sk_...)
  // phoneSigningKey: Webhook signing key for signature verification
  phoneAccountSid: string;
  phoneApiKey: string;
  phoneSigningKey: string;
  phoneNumber: string;

  // OpenAI (TTS + STT)
  openaiApiKey: string;
  ttsVoice?: string;
  sttModel?: string;
  sttSilenceDurationMs?: number;

  // Inbound call settings
  inboundEnabled: boolean;
  inboundWhitelist: string[];
  inboundWorkspaceDir: string;
  inboundPermissionMode: string;
  inboundMaxCalls: number;
  inboundGreeting: string;
}

export function loadProviderConfig(): ProviderConfig {
  const sttSilenceDurationMs = process.env.CALLME_STT_SILENCE_DURATION_MS
    ? parseInt(process.env.CALLME_STT_SILENCE_DURATION_MS, 10)
    : undefined;

  return {
    phoneAccountSid: process.env.CALLME_PHONE_ACCOUNT_SID || '',
    phoneApiKey: process.env.CALLME_PHONE_API_KEY || '',
    phoneSigningKey: process.env.CALLME_PHONE_SIGNING_KEY || '',
    phoneNumber: process.env.CALLME_PHONE_NUMBER || '',
    openaiApiKey: process.env.CALLME_OPENAI_API_KEY || '',
    ttsVoice: process.env.CALLME_TTS_VOICE || 'onyx',
    sttModel: process.env.CALLME_STT_MODEL || 'gpt-4o-transcribe',
    sttSilenceDurationMs,
    inboundEnabled: process.env.CALLME_INBOUND_ENABLED === 'true',
    inboundWhitelist: process.env.CALLME_INBOUND_WHITELIST
      ? process.env.CALLME_INBOUND_WHITELIST.split(',').map(s => s.trim()).filter(Boolean)
      : [],
    inboundWorkspaceDir: process.env.CALLME_WORKSPACE_DIR || '',
    inboundPermissionMode: process.env.CALLME_INBOUND_PERMISSION_MODE || 'plan',
    inboundMaxCalls: parseInt(process.env.CALLME_INBOUND_MAX_CALLS || '1', 10),
    inboundGreeting: process.env.CALLME_INBOUND_GREETING || '안녕하세요. 잠시만 기다려주세요. 연결 중입니다.',
  };
}

export function createPhoneProvider(config: ProviderConfig): PhoneProvider {
  const provider = new ClawOpsPhoneProvider();
  provider.initialize({
    accountSid: config.phoneAccountSid,
    phoneNumber: config.phoneNumber,
    apiKey: config.phoneApiKey,
    signingKey: config.phoneSigningKey,
  });
  return provider;
}

export function createTTSProvider(config: ProviderConfig): TTSProvider {
  const provider = new OpenAITTSProvider();
  provider.initialize({
    apiKey: config.openaiApiKey,
    voice: config.ttsVoice,
  });
  return provider;
}

export function createSTTProvider(config: ProviderConfig): RealtimeSTTProvider {
  const provider = new OpenAIRealtimeSTTProvider();
  provider.initialize({
    apiKey: config.openaiApiKey,
    model: config.sttModel,
    silenceDurationMs: config.sttSilenceDurationMs,
  });
  return provider;
}

export function createProviders(config: ProviderConfig): ProviderRegistry {
  return {
    phone: createPhoneProvider(config),
    tts: createTTSProvider(config),
    stt: createSTTProvider(config),
  };
}

/**
 * Validate that required config is present
 */
export function validateProviderConfig(config: ProviderConfig): string[] {
  const errors: string[] = [];

  if (!config.phoneAccountSid) {
    errors.push('Missing CALLME_PHONE_ACCOUNT_SID (ClawOps Account ID, AC...)');
  }
  if (!config.phoneApiKey) {
    errors.push('Missing CALLME_PHONE_API_KEY (ClawOps API Key, sk_...)');
  }
  if (!config.phoneSigningKey) {
    errors.push('Missing CALLME_PHONE_SIGNING_KEY (ClawOps Webhook Signing Key)');
  }
  if (!config.phoneNumber) {
    errors.push('Missing CALLME_PHONE_NUMBER');
  }
  if (!config.openaiApiKey) {
    errors.push('Missing CALLME_OPENAI_API_KEY');
  }

  return errors;
}
