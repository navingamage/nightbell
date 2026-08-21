/**
 * Stand-ins for the carrier and the two audio providers.
 *
 * Shared by the scripted harness and the interactive one, which want exactly
 * the same call assembled around a different source of caller speech: the
 * harness reads it from a scenario, the interactive runner reads it from the
 * keyboard. Everything below the session is identical either way, and there is
 * only one of these worth getting right.
 */

import { encode } from "../call/audio.js";
import type {
  SpeechRecogniser,
  SpeechSynthesiser,
  Transcript,
} from "../providers/types.js";
import type { TenantConfig } from "../call/session.js";

/** The demo tenant. A real one comes from the control plane at call time. */
export const TENANT: TenantConfig = {
  tenantId: "t_demo",
  businessName: "Buckeye Restoration",
  serviceArea: "Austin and the surrounding counties",
  timezone: "America/Chicago",
  onCallNumber: "+15125550199",
  greeting:
    "Buckeye Restoration, this is the after-hours line. What's the best number to reach you on, in case we get cut off?",
};

/** Recogniser that emits whatever it is handed, as a final transcript. */
export class TypedRecogniser implements SpeechRecogniser {
  private handler: ((t: Transcript) => void) | null = null;
  write(): void {}
  async finish(): Promise<void> {}
  close(): void {}
  onTranscript(h: (t: Transcript) => void): void {
    this.handler = h;
  }
  onError(): void {}
  say(text: string): void {
    this.handler?.({ text, isFinal: true, speechFinal: true });
  }
}

/** Synthesiser that prints instead of speaking, and reports realistic timing. */
export class PrintingSynthesiser implements SpeechSynthesiser {
  lines: string[] = [];
  /** Called as each sentence is handed over, for a runner that prints live. */
  onLine: ((text: string) => void) | null = null;

  async *speak(text: string, signal: AbortSignal): AsyncIterable<Buffer> {
    this.lines.push(text);
    this.onLine?.(text);
    // Cartesia's time-to-first-audio, roughly, so the printed latency figures
    // mean something rather than being instant.
    await new Promise((r) => setTimeout(r, 110));
    if (signal.aborted) return;
    // One frame per ~60ms of speech, at a natural speaking rate.
    const frames = Math.max(1, Math.round(text.length / 14));
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) return;
      yield encode(new Int16Array(160));
    }
  }
  close(): void {}
}

/**
 * A stand-in for the carrier socket that also plays Twilio's part.
 *
 * Twilio sends a `mark` event back once the audio preceding it has actually
 * finished playing, and that event is the only thing that tells the turn
 * controller the agent has stopped talking. Swallowing it, as an inert fake
 * socket does, leaves the controller believing the agent is still speaking
 * forever, so every subsequent caller turn is classified as a barge-in, the
 * generation is aborted, and its tool calls are discarded. The intake then
 * silently collects nothing.
 *
 * Echoing the mark back is what makes this a fake of Twilio rather than a fake
 * of a socket.
 */
export function fakeCarrier(): {
  socket: import("ws").WebSocket;
  onMark: (deliver: (name: string) => void) => void;
} {
  let deliverMark: ((name: string) => void) | null = null;

  const socket = {
    OPEN: 1 as const,
    readyState: 1 as const,
    send: (raw: string) => {
      const parsed = JSON.parse(raw) as { event?: string; mark?: { name?: string } };
      if (parsed.event === "mark" && parsed.mark?.name) {
        const name = parsed.mark.name;
        setTimeout(() => deliverMark?.(name), 0);
      }
    },
    close: () => {},
  };

  return {
    socket: socket as unknown as import("ws").WebSocket,
    onMark: (deliver) => {
      deliverMark = deliver;
    },
  };
}

/** Loud frames, which is what opens a caller turn on a real call. */
export function openTurn(onAudio: (frame: Buffer) => void, frames = 10): void {
  const loud = encode(new Int16Array(160).fill(12000));
  for (let i = 0; i < frames; i++) onAudio(loud);
}

/**
 * Wait for the agent to stop talking.
 *
 * A fixed pause cannot work against a real model: time to first sentence varies
 * with load, and a turn that files a tool call costs two round trips, with the
 * second reply landing seconds after the first. A pause long enough for that
 * worst case is paid on every turn; one that is not long enough reads the
 * session before it has finished answering. So watch what the agent is actually
 * saying and call the turn settled once it has gone quiet. FLOOR keeps a slow
 * first sentence from being mistaken for silence, and CAP stops a wedged turn
 * from hanging the run.
 */
export function settler(
  synthesiser: PrintingSynthesiser,
  opts: { floorMs: number; quietMs: number; capMs?: number },
): () => Promise<void> {
  const POLL = 100;
  const cap = opts.capMs ?? 45_000;

  return async () => {
    const startedAt = performance.now();
    let seen = synthesiser.lines.length;
    let changedAt = startedAt;

    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL));
      const now = performance.now();

      if (synthesiser.lines.length !== seen) {
        seen = synthesiser.lines.length;
        changedAt = now;
      }

      if (now - startedAt < opts.floorMs) continue;
      if (now - changedAt >= opts.quietMs) return;
      if (now - startedAt >= cap) return;
    }
  };
}
