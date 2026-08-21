/**
 * The Twilio Media Streams protocol.
 *
 * A bidirectional WebSocket carrying JSON messages, each with a base64 μ-law
 * payload. The details that matter operationally:
 *
 *   - Frames we send are *queued* on Twilio's side and play out in order. This
 *     is why barge-in needs an explicit `clear`: stopping generation does
 *     nothing about the two seconds of audio already handed over, and without
 *     the clear the agent keeps talking over the caller for as long as the
 *     buffer lasts.
 *
 *   - `mark` messages come back after a specific point in the audio has
 *     actually played. That is the only way to know when the agent has really
 *     finished speaking, as opposed to when we finished *sending*.
 */

export interface TwilioStart {
  streamSid: string;
  callSid: string;
  accountSid: string;
  tracks: string[];
  customParameters?: Record<string, string>;
}

export type TwilioInbound =
  | { event: "connected"; protocol: string; version: string }
  | { event: "start"; sequenceNumber: string; streamSid: string; start: TwilioStart }
  | {
      event: "media";
      sequenceNumber: string;
      streamSid: string;
      media: { track: string; chunk: string; timestamp: string; payload: string };
    }
  | { event: "stop"; sequenceNumber: string; streamSid: string; stop: { accountSid: string; callSid: string } }
  | { event: "mark"; sequenceNumber: string; streamSid: string; mark: { name: string } }
  | { event: "dtmf"; sequenceNumber: string; streamSid: string; dtmf: { track: string; digit: string } };

export function parseInbound(raw: string): TwilioInbound | null {
  try {
    const parsed = JSON.parse(raw) as TwilioInbound;
    return typeof parsed?.event === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Decode the base64 payload of a media message into raw μ-law bytes. */
export function mediaPayload(msg: Extract<TwilioInbound, { event: "media" }>): Buffer {
  return Buffer.from(msg.media.payload, "base64");
}

/** A frame of agent audio to play to the caller. */
export function mediaMessage(streamSid: string, ulaw: Buffer): string {
  return JSON.stringify({
    event: "media",
    streamSid,
    media: { payload: ulaw.toString("base64") },
  });
}

/**
 * Discard everything queued but not yet played.
 *
 * The single most important message in the protocol for making an agent feel
 * interruptible. Without it, barge-in is cosmetic.
 */
export function clearMessage(streamSid: string): string {
  return JSON.stringify({ event: "clear", streamSid });
}

/** Ask Twilio to tell us when playback reaches this point. */
export function markMessage(streamSid: string, name: string): string {
  return JSON.stringify({ event: "mark", streamSid, mark: { name } });
}

/**
 * TwiML that connects an inbound call to this media server.
 *
 * Served by the control plane on the Twilio webhook. The greeting is spoken by
 * the agent rather than by TwiML `<Say>` so that the voice is consistent from
 * the very first word. A robotic greeting followed by a natural voice is a
 * jarring tell, and it happens on the one turn where the caller is paying most
 * attention.
 */
export function connectTwiml(wsUrl: string, params: Record<string, string> = {}): string {
  const attrs = Object.entries(params)
    .map(([k, v]) => `<Parameter name="${escapeXml(k)}" value="${escapeXml(v)}" />`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${escapeXml(wsUrl)}">${attrs}</Stream></Connect></Response>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
