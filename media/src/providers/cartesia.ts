/**
 * Cartesia streaming speech synthesis.
 *
 * Same format argument as the recogniser: Cartesia will emit `pcm_mulaw` at
 * 8 kHz, which is exactly what Twilio wants, so synthesised audio goes to the
 * carrier without a conversion step.
 *
 * The interface returns an async iterable rather than a callback because
 * cancellation has to be trivially correct. When a caller barges in, the
 * consumer stops iterating and aborts the signal; the socket closes and no
 * further audio can reach the caller. A callback-based design makes it far too
 * easy to leave one last chunk in flight, and one stray chunk after a barge-in
 * is audible as the agent talking over the caller — the exact failure the
 * barge-in logic exists to prevent.
 */

import { WebSocket } from "ws";
import type { SpeechSynthesiser } from "./types.js";

const CARTESIA_URL = "wss://api.cartesia.ai/tts/websocket";
const CARTESIA_VERSION = "2024-06-10";

export interface CartesiaOptions {
  apiKey: string;
  voiceId: string;
  model?: string;
  /** Words per minute relative to the voice's default. */
  speed?: "slow" | "normal" | "fast";
}

export class CartesiaSynthesiser implements SpeechSynthesiser {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly opts: CartesiaOptions) {}

  private connect(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve, reject) => {
      const params = new URLSearchParams({
        api_key: this.opts.apiKey,
        cartesia_version: CARTESIA_VERSION,
      });
      const ws = new WebSocket(`${CARTESIA_URL}?${params}`);
      this.ws = ws;

      ws.once("open", () => resolve());
      ws.once("error", (err: Error) => {
        this.ready = null;
        reject(err);
      });
      ws.once("close", () => {
        this.ready = null;
        this.ws = null;
      });
    });

    return this.ready;
  }

  /**
   * Synthesise one sentence, yielding μ-law audio as it is generated.
   *
   * Each call uses a fresh context id. Cartesia can continue an existing
   * context to preserve prosody across sentences, which sounds better — but it
   * also means an aborted sentence leaves the context in an indeterminate
   * state. Given how often barge-in happens on distress calls, correctness
   * after interruption is worth more than prosodic continuity.
   */
  async *speak(text: string, signal: AbortSignal): AsyncIterable<Buffer> {
    if (signal.aborted) return;
    await this.connect();
    const ws = this.ws;
    if (!ws) return;

    const contextId = `nb-${process.hrtime.bigint().toString(36)}`;
    const chunks: Buffer[] = [];
    let done = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;

    const notify = (): void => {
      wake?.();
      wake = null;
    };

    const onMessage = (raw: Buffer): void => {
      let msg: { type?: string; context_id?: string; data?: string; error?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.context_id !== contextId) return;

      if (msg.type === "chunk" && msg.data) {
        chunks.push(Buffer.from(msg.data, "base64"));
        notify();
      } else if (msg.type === "done") {
        done = true;
        notify();
      } else if (msg.type === "error") {
        failure = new Error(msg.error ?? "cartesia synthesis failed");
        done = true;
        notify();
      }
    };

    const onAbort = (): void => {
      done = true;
      notify();
    };

    ws.on("message", onMessage);
    signal.addEventListener("abort", onAbort, { once: true });

    ws.send(
      JSON.stringify({
        model_id: this.opts.model ?? "sonic-2",
        transcript: text,
        voice: { mode: "id", id: this.opts.voiceId },
        language: "en",
        context_id: contextId,
        continue: false,
        output_format: {
          container: "raw",
          encoding: "pcm_mulaw",
          sample_rate: 8000,
        },
        ...(this.opts.speed ? { speed: this.opts.speed } : {}),
      }),
    );

    try {
      for (;;) {
        while (chunks.length > 0) {
          if (signal.aborted) return;
          yield chunks.shift()!;
        }
        if (done || signal.aborted) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (failure && !signal.aborted) throw failure;
    } finally {
      ws.off("message", onMessage);
      signal.removeEventListener("abort", onAbort);
    }
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.ready = null;
  }
}
