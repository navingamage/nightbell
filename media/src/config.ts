/**
 * Configuration, read once at boot.
 *
 * Every value is required and the process refuses to start without it. A voice
 * agent that boots with a missing API key does not fail visibly — it answers
 * the phone, fails on the first turn, and hangs up on a customer. Failing at
 * deploy time is enormously preferable to failing at 2am on someone's flood.
 */

export interface Config {
  port: number;
  publicHost: string;
  deepgramApiKey: string;
  cartesiaApiKey: string;
  cartesiaVoiceId: string;
  anthropicApiKey: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  /** Base URL of the Cloudflare control plane. */
  controlPlaneUrl: string;
  /** Shared secret for calls between the media server and the control plane. */
  controlPlaneToken: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env["PORT"] ?? 8080),
    publicHost: required("PUBLIC_HOST"),
    deepgramApiKey: required("DEEPGRAM_API_KEY"),
    cartesiaApiKey: required("CARTESIA_API_KEY"),
    cartesiaVoiceId: required("CARTESIA_VOICE_ID"),
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    twilioAccountSid: required("TWILIO_ACCOUNT_SID"),
    twilioAuthToken: required("TWILIO_AUTH_TOKEN"),
    controlPlaneUrl: required("CONTROL_PLANE_URL"),
    controlPlaneToken: required("CONTROL_PLANE_TOKEN"),
  };
}
