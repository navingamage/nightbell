/**
 * Deepgram streaming speech recognition.
 *
 * The important configuration decision is the audio format: Deepgram accepts
 * 8 kHz μ-law directly, so carrier frames go over the wire byte-for-byte as
 * they arrive. No decode, no resample, no re-encode. Two format conversions
 * removed from the hot path is worth more than any model choice, and it is the
 * reason audio.ts treats μ-law as the native format rather than an edge case.
 *
 * `endpointing` is set low and deliberately. Deepgram's own endpoint detection
 * has an acoustic model behind it and is better than the energy heuristic in
 * turn.ts, but it does not know what question was just asked, and turn.ts
 * does. So Deepgram is configured to report endpoints eagerly and turn.ts
 * decides whether to act on them.
 */

import { WebSocket } from "ws";
import type { SpeechRecogniser, Transcript } from "./types.js";

const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";

export interface DeepgramOptions {
  apiKey: string;
  model?: string;
  /** Milliseconds of silence before Deepgram reports an endpoint. */
  endpointingMs?: number;
  /** Domain vocabulary to bias recognition toward. */
  keywords?: string[];
}

/**
 * Terms a general-purpose recogniser mishears on restoration calls.
 *
 * These are cheap to add and disproportionately valuable: "cat three" is the
 * difference between a routine booking and a same-night dispatch, and a
 * recogniser that renders it as "cat tree" hands the triage layer nothing to
 * match on.
 */
export const RESTORATION_KEYWORDS = [
  "sewage", "sewer", "septic", "backflow", "sump", "dehumidifier",
  "extraction", "remediation", "mitigation", "mold", "mould", "drywall",
  "baseboard", "subfloor", "crawlspace", "shutoff", "supply line",
  "category three", "cat three", "IICRC", "adjuster", "deductible",
];

export class DeepgramRecogniser implements SpeechRecogniser {
  private ws: WebSocket;
  private transcriptHandler: ((t: Transcript) => void) | null = null;
  private errorHandler: ((e: Error) => void) | null = null;
  /** Frames that arrive before the socket opens, so no audio is lost. */
  private queue: Buffer[] = [];
  private open = false;

  constructor(opts: DeepgramOptions) {
    const params = new URLSearchParams({
      encoding: "mulaw",
      sample_rate: "8000",
      channels: "1",
      model: opts.model ?? "nova-3",
      interim_results: "true",
      smart_format: "true",
      // Punctuation matters here: the sentence splitter downstream and the
      // triage regexes both read better text when numbers are formatted.
      punctuate: "true",
      endpointing: String(opts.endpointingMs ?? 300),
    });
    for (const keyword of opts.keywords ?? RESTORATION_KEYWORDS) {
      params.append("keyterm", keyword);
    }

    this.ws = new WebSocket(`${DEEPGRAM_URL}?${params}`, {
      headers: { Authorization: `Token ${opts.apiKey}` },
    });

    this.ws.on("open", () => {
      this.open = true;
      for (const frame of this.queue) this.ws.send(frame);
      this.queue = [];
    });

    this.ws.on("message", (raw: Buffer) => this.handleMessage(raw));
    this.ws.on("error", (err: Error) => this.errorHandler?.(err));
  }

  private handleMessage(raw: Buffer): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // Keepalives and binary noise; nothing actionable.
    }

    const parsed = msg as {
      type?: string;
      is_final?: boolean;
      speech_final?: boolean;
      channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
    };

    if (parsed.type && parsed.type !== "Results") return;

    const alternative = parsed.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim();
    if (!text) return;

    this.transcriptHandler?.({
      text,
      isFinal: parsed.is_final === true,
      ...(parsed.speech_final !== undefined ? { speechFinal: parsed.speech_final } : {}),
      ...(alternative?.confidence !== undefined ? { confidence: alternative.confidence } : {}),
    });
  }

  write(ulaw: Buffer): void {
    if (!this.open) {
      // Bounded, so a socket that never opens cannot grow without limit.
      if (this.queue.length < 250) this.queue.push(ulaw);
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(ulaw);
  }

  async finish(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
    }
  }

  close(): void {
    this.queue = [];
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }

  onTranscript(handler: (t: Transcript) => void): void {
    this.transcriptHandler = handler;
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }
}
