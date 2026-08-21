/**
 * Provider-facing interfaces.
 *
 * Speech recognition, speech synthesis and the model itself are all commodity
 * services with near-identical shapes and wildly different latency
 * characteristics, and the ones that are fastest today are not reliably the
 * ones that will be fastest in six months. Everything above this file is
 * written against these three interfaces so a provider swap is a constructor
 * change rather than a rewrite of the call loop.
 *
 * The interfaces are streaming-first and cancellable, because both properties
 * are load-bearing on a phone call. A synthesiser that cannot be interrupted
 * mid-sentence cannot support barge-in, and a model that only returns complete
 * responses adds its entire generation time to every turn.
 */

/** A recognised piece of caller speech. */
export interface Transcript {
  text: string;
  /** False for interim hypotheses that may still change. */
  isFinal: boolean;
  /** Provider's own endpoint signal, if it has one. Usually better than energy. */
  speechFinal?: boolean;
  confidence?: number;
}

/**
 * Streaming speech recognition over a live call.
 *
 * Audio goes in as 8 kHz μ-law frames, exactly as they arrive from the carrier.
 * Anything that needs a different format converts internally, so the hot path
 * does not pay for a conversion that a given provider may not even need.
 */
export interface SpeechRecogniser {
  /** Push one inbound audio frame. Must be non-blocking. */
  write(ulaw: Buffer): void;
  /** Signal the end of the caller's audio and flush any pending hypothesis. */
  finish(): Promise<void>;
  close(): void;
  onTranscript(handler: (t: Transcript) => void): void;
  onError(handler: (err: Error) => void): void;
}

/**
 * Streaming speech synthesis.
 *
 * `speak` returns an async iterable of μ-law audio so the caller can begin
 * playing the first syllable while the rest is still being generated. Time to
 * *first* byte is what matters here; total generation time is nearly
 * irrelevant, because playback is realtime anyway.
 */
export interface SpeechSynthesiser {
  speak(text: string, signal: AbortSignal): AsyncIterable<Buffer>;
  close(): void;
}

/** A tool the model may call during a conversation. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ConversationTurn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool_result"; toolUseId: string; content: string };

/**
 * A streamed model response.
 *
 * Text arrives sentence by sentence rather than token by token, because the
 * synthesiser wants natural prosodic units. Splitting on tokens produces
 * choppy speech; waiting for the whole response wastes the time-to-first-audio
 * that streaming was meant to buy.
 */
export interface ModelResponse {
  /** Sentences as they complete, ready to hand to the synthesiser. */
  sentences: AsyncIterable<string>;
  /** Resolves once generation is done, with any tools the model wants to run. */
  toolCalls: Promise<ToolCall[]>;
}

export interface LanguageModel {
  respond(params: {
    /**
     * Instructions that do not change for the duration of a call. Kept separate
     * from `context` so a provider can cache it: caching is a prefix match, and
     * a single changed byte anywhere in the system prompt re-bills everything
     * after it.
     */
    system: string;
    /**
     * Per-turn state: the time, what is still outstanding, whether triage has
     * escalated. Changes almost every turn, so it belongs after the cache
     * breakpoint rather than in `system`, however naturally it reads there.
     */
    context?: string;
    history: ConversationTurn[];
    tools: ToolDefinition[];
    signal: AbortSignal;
  }): ModelResponse;
}
