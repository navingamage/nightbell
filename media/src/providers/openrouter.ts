/**
 * OpenRouter, as the conversational layer.
 *
 * The model's job here is narrower than it first appears. It does not decide
 * urgency; triage.ts does, and applyModelOpinion() only lets the model raise
 * the result. It does not decide whether a job is bookable either, schema.ts does.
 * What the model is genuinely good at, and what nothing else here can do, is
 * holding a natural conversation with a distressed person while extracting
 * structured facts from what they say in whatever order they choose to say it.
 *
 * Going through OpenRouter rather than a single vendor's SDK is a deliberate
 * choice for this particular job. An intake turn is a short reply over a
 * growing transcript, which nearly every instruction-tuned model can do; what
 * separates them on a phone call is time to first token and price, and neither
 * ranking holds still for long. One base URL and a model string means switching
 * is a config change made between two calls rather than a dependency swap.
 *
 * The client is hand-rolled because the surface in use is one POST with a JSON
 * body and Node has fetch built in. Carrying a vendor SDK for that would be the
 * heaviest dependency in the process.
 *
 * Streaming is mandatory rather than an optimisation. Time-to-first-audio is
 * the number the caller experiences, and waiting for a complete response before
 * synthesising any of it adds the entire generation time to every single turn.
 *
 * Prompt caching matters for cost rather than latency. A fifteen-turn intake
 * resends the tool definitions, the system prompt, and the entire transcript so
 * far on every turn, and all of it is identical to what was sent a few seconds
 * earlier. Most providers behind OpenRouter cache a repeated prefix on their
 * own and bill the hit at a fraction of the input price; Anthropic's models
 * want to be told where the prefix ends, so `anthropicCacheControl` marks it
 * for them and does nothing for anyone else.
 *
 * Either way the rule is the same, and it is the whole reason `system` and
 * `context` arrive here as separate strings: caching matches on an exact byte
 * prefix, so anything that changes between turns has to sit at the very end of
 * the request. Put the clock reading in the system prompt and no two turns ever
 * match, the cache never reads, and the caching becomes a surcharge.
 */

import { SentenceSplitter } from "./sentences.js";
import type {
  ConversationTurn,
  LanguageModel,
  ModelResponse,
  ToolCall,
  ToolDefinition,
} from "./types.js";

/**
 * The cheapest model measured that gets the safety cases right.
 *
 * Chosen by running the harness scenarios, which is the only way this should
 * ever be chosen. The tier below it is a third of the price and holds a
 * perfectly reasonable conversation, but it failed to transfer a caller who
 * asked outright for a person, and that is the one rule in this system with no
 * acceptable failure rate. Where this model is wrong it is wrong in the
 * expensive direction, escalating calls that did not need it, which is the
 * trade docs/safety.md argues for everywhere else.
 *
 * Overridable per deployment precisely because none of this is durable. Prices
 * and time-to-first-token move month to month, so re-run the scenarios rather
 * than trusting this line.
 */
export const DEFAULT_MODEL = "google/gemini-2.5-flash";

const BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
}

/** OpenAI chat-completions wire shapes, only the parts this client uses. */
interface WireTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | WireTextBlock[] | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: WireUsage;
  error?: { message?: string; code?: number | string };
}

export class OpenRouterModel implements LanguageModel {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;

  /**
   * Tool calls this instance has emitted, by id.
   *
   * The transcript in session.ts is provider-neutral: a tool result carries the
   * id it answers and nothing else, because the name and arguments were the
   * model's own and the session has no use for them. The chat-completions
   * schema does have a use for them, because a `tool` message is only legal
   * after an assistant message that made the matching call, so this remembers
   * what it sent. One instance per call, and a call is at most a few dozen
   * turns, so this stays small on its own.
   */
  private readonly emitted = new Map<string, { name: string; arguments: string }>();

  constructor(opts: OpenRouterOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.model = opts.model ?? DEFAULT_MODEL;
    // Replies are spoken aloud, so they are short by construction. A low cap is
    // a useful backstop against a model that decides to give a speech.
    this.maxTokens = opts.maxTokens ?? 512;
  }

  respond(params: {
    system: string;
    context?: string;
    history: ConversationTurn[];
    tools: ToolDefinition[];
    signal: AbortSignal;
  }): ModelResponse {
    const sentenceQueue: string[] = [];
    let finished = false;
    let streamError: Error | null = null;
    let wake: (() => void) | null = null;

    const notify = (): void => {
      wake?.();
      wake = null;
    };

    let resolveTools: (calls: ToolCall[]) => void;
    let rejectTools: (err: Error) => void;
    const toolCalls = new Promise<ToolCall[]>((resolve, reject) => {
      resolveTools = resolve;
      rejectTools = reject;
    });

    // A stream error rejects both halves of the response, and the session only
    // ever awaits one of them: the sentence iterator throws first, the catch
    // around it ends the turn, and nothing is left to await the tool calls. Node
    // treats that rejection as unhandled and kills the process, so a single 429
    // from one provider takes down every other call on the instance with it.
    // Found on the first live run against a rate-limited model.
    toolCalls.catch(() => {});

    const run = async (): Promise<void> => {
      const splitter = new SentenceSplitter();
      const pending = new Map<number, { id: string; name: string; args: string }>();

      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
            // OpenRouter attributes traffic by these, and they are what the
            // dashboard groups spend under.
            "http-referer": "https://nightbell.antipodetech.com",
            "x-title": "nightbell",
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: this.maxTokens,
            stream: true,
            // Ask for the billed cost of the request rather than inferring it
            // from token counts and a price list that may be a month stale.
            usage: { include: true },
            messages: this.toWireMessages(params.system, params.history, params.context ?? ""),
            ...(params.tools.length > 0 ? { tools: toWireTools(params.tools) } : {}),
          }),
          signal: params.signal,
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          throw new Error(
            `openrouter ${response.status}: ${detail.slice(0, 400) || response.statusText}`,
          );
        }

        for await (const chunk of readSSE(response.body)) {
          if (chunk.error) {
            throw new Error(`openrouter: ${chunk.error.message ?? "stream error"}`);
          }

          if (chunk.usage) logUsage(this.model, chunk.usage);

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            for (const sentence of splitter.push(delta.content)) {
              sentenceQueue.push(sentence);
              notify();
            }
          }

          // Tool calls arrive in fragments keyed by index: the id and name once,
          // the JSON arguments a few characters at a time.
          for (const fragment of delta.tool_calls ?? []) {
            const slot = pending.get(fragment.index) ?? { id: "", name: "", args: "" };
            if (fragment.id) slot.id = fragment.id;
            if (fragment.function?.name) slot.name = fragment.function.name;
            if (fragment.function?.arguments) slot.args += fragment.function.arguments;
            pending.set(fragment.index, slot);
          }
        }

        const tail = splitter.flush();
        if (tail) {
          sentenceQueue.push(tail);
          notify();
        }

        const collected: ToolCall[] = [];
        for (const slot of [...pending.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
          if (!slot.name) continue;
          const id = slot.id || `call_${collected.length}`;
          this.emitted.set(id, { name: slot.name, arguments: slot.args || "{}" });
          collected.push({ id, name: slot.name, input: parseArguments(slot.args) });
        }

        resolveTools(collected);
      } catch (err) {
        // An abort is a barge-in, not a failure: the caller interrupted and the
        // partial response is meant to be discarded.
        if (params.signal.aborted) {
          resolveTools([]);
          return;
        }
        streamError = err instanceof Error ? err : new Error(String(err));
        rejectTools(streamError);
      } finally {
        finished = true;
        notify();
      }
    };

    void run();

    const sentences = (async function* (): AsyncIterable<string> {
      for (;;) {
        while (sentenceQueue.length > 0) {
          if (params.signal.aborted) return;
          yield sentenceQueue.shift()!;
        }
        if (finished || params.signal.aborted) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (streamError && !params.signal.aborted) throw streamError;
    })();

    return { sentences, toolCalls };
  }

  /**
   * Fold the transcript into chat-completions messages.
   *
   * Two rules drive the shape. A `tool` message is only legal directly after an
   * assistant message that made the matching call, so each run of tool results
   * gets its calls reattached to the assistant turn in front of it, or a bare
   * assistant turn invented, for the common case where the model called a tool
   * and said nothing. And the volatile per-turn context goes last, after the
   * cache breakpoint, so the prefix in front of it is byte-identical to the one
   * sent a few seconds ago.
   */
  private toWireMessages(
    system: string,
    history: ConversationTurn[],
    context: string,
  ): WireMessage[] {
    const messages: WireMessage[] = [{ role: "system", content: system }];

    for (let i = 0; i < history.length; ) {
      const turn = history[i]!;

      if (turn.role !== "tool_result") {
        const last = messages[messages.length - 1];
        if (last?.role === turn.role && typeof last.content === "string" && !last.tool_calls) {
          last.content += ` ${turn.content}`;
        } else {
          messages.push({ role: turn.role, content: turn.content });
        }
        i++;
        continue;
      }

      // Everything the model filed in one response comes back as a run of
      // results, and they all answer the same assistant turn.
      const run: Array<{ toolUseId: string; content: string }> = [];
      while (i < history.length && history[i]!.role === "tool_result") {
        const result = history[i] as { toolUseId: string; content: string };
        run.push(result);
        i++;
      }

      const answered = run.filter((r) => this.emitted.has(r.toolUseId));
      // A result whose call this instance never made: a resumed session, or a
      // provider that dropped the id. Degrading it to plain text keeps the model
      // informed instead of the request being rejected outright.
      const orphaned = run.filter((r) => !this.emitted.has(r.toolUseId));

      if (answered.length > 0) {
        const calls: WireToolCall[] = answered.map((r) => {
          const known = this.emitted.get(r.toolUseId)!;
          return {
            id: r.toolUseId,
            type: "function",
            function: { name: known.name, arguments: known.arguments },
          };
        });

        const last = messages[messages.length - 1];
        if (last?.role === "assistant" && typeof last.content === "string" && !last.tool_calls) {
          last.tool_calls = calls;
        } else {
          // The model called a tool and said nothing, which is the common case
          // mid-intake. The schema still wants an assistant turn to hang the
          // calls off.
          messages.push({ role: "assistant", content: "", tool_calls: calls });
        }

        for (const r of answered) {
          messages.push({ role: "tool", tool_call_id: r.toolUseId, content: r.content });
        }
      }

      for (const r of orphaned) {
        messages.push({ role: "user", content: `Tool result: ${r.content}` });
      }
    }

    this.anthropicCacheControl(messages);

    // System role, not user: the per-turn state block is addressed to the model,
    // and a model that receives it as a user message may answer it as though the
    // caller had said it. Trailing rather than merged into the leading system
    // message, because it changes every turn and everything in front of it has
    // to stay byte-identical for the cache to read.
    if (context) messages.push({ role: "system", content: context });

    return messages;
  }

  /**
   * Mark the end of the reusable prefix, for models that want to be told.
   *
   * Anthropic bills a cache write and reads it back on later turns only where a
   * breakpoint says to; everyone else behind OpenRouter does prefix caching
   * automatically and ignores this field. So it costs nothing to set and saves
   * most of the input bill on the one family that needs it.
   *
   * The breakpoint goes on the system prompt and on the last message the model
   * has already seen. Putting it before the per-turn context rather than at the
   * very end is the trick: the other way round, the clock reading would be part
   * of the cached prefix, no two turns would match, and the result would be a
   * write on every turn and a read on none.
   */
  private anthropicCacheControl(messages: WireMessage[]): void {
    if (!this.model.startsWith("anthropic/")) return;

    for (const message of [messages[0], messages[messages.length - 1]]) {
      if (!message || typeof message.content !== "string" || !message.content) continue;
      message.content = [
        { type: "text", text: message.content, cache_control: { type: "ephemeral" } },
      ];
    }
  }
}

function toWireTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

/**
 * Tool arguments, or an empty object.
 *
 * A truncated or malformed argument string is a bad turn, not a dead call. The
 * session treats an empty input as "the model recorded nothing", asks its next
 * question, and the caller never learns anything went wrong. That is a great
 * deal better than an exception unwinding the turn mid-sentence.
 */
function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Server-sent events, decoded into chunks.
 *
 * OpenRouter sends `: OPENROUTER PROCESSING` comment lines while a slow
 * upstream warms up, which keep the connection alive and must be skipped rather
 * than parsed. Events are separated by a blank line, and a partial line at the
 * end of a network chunk has to be carried into the next one.
 */
async function* readSSE(body: ReadableStream<Uint8Array>): AsyncIterable<WireChunk> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });

    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);

      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;

      try {
        yield JSON.parse(payload) as WireChunk;
      } catch {
        // A chunk that is not JSON is not something to fail a call over.
      }
    }
  }
}

/**
 * Report what a turn cost, and how much of it was a cache read, when
 * NIGHTBELL_CACHE_STATS is set.
 *
 * Worth a switch, because a broken cache is silent by construction: the request
 * still succeeds and the reply is still correct, it just costs several times
 * what it should. If the cached count stays at zero across a call, something
 * upstream is changing the prefix.
 */
function logUsage(model: string, usage: WireUsage): void {
  if (!process.env["NIGHTBELL_CACHE_STATS"]) return;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  console.log(
    `[usage] ${model}: ${usage.prompt_tokens ?? 0} in (${cached} cached), ` +
      `${usage.completion_tokens ?? 0} out, $${(usage.cost ?? 0).toFixed(6)}`,
  );
}
