/**
 * Claude, as the conversational layer.
 *
 * The model's job here is narrower than it first appears. It does not decide
 * urgency — triage.ts does, and applyModelOpinion() only lets the model raise
 * the result. It does not decide whether a job is bookable — schema.ts does.
 * What the model is genuinely good at, and what nothing else here can do, is
 * holding a natural conversation with a distressed person while extracting
 * structured facts from what they say in whatever order they choose to say it.
 *
 * Streaming is mandatory rather than an optimisation. Time-to-first-audio is
 * the number the caller experiences, and waiting for a complete response before
 * synthesising any of it adds the entire generation time to every single turn.
 *
 * Prompt caching is close to mandatory too, for cost rather than latency. A
 * fifteen-turn intake resends the tool definitions, the system prompt, and the
 * entire transcript so far on every turn, and all of it is identical to what
 * was sent a few seconds earlier. Two breakpoints below turn nearly all of that
 * re-reading into cache reads at about a tenth of the input price.
 *
 * Caching matches on an exact byte prefix, which is the whole reason `system`
 * and `context` arrive here as separate strings. Anything that changes between
 * turns must sit after the last breakpoint or it invalidates everything behind
 * it and the caching silently becomes a surcharge instead of a saving.
 */

import Anthropic from "@anthropic-ai/sdk";
import { SentenceSplitter } from "./sentences.js";
import type {
  ConversationTurn,
  LanguageModel,
  ModelResponse,
  ToolCall,
  ToolDefinition,
} from "./types.js";

export interface ClaudeOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

export class ClaudeModel implements LanguageModel {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: ClaudeOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? "claude-sonnet-5";
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

    const run = async (): Promise<void> => {
      const splitter = new SentenceSplitter();
      const collected: ToolCall[] = [];

      try {
        const stream = this.client.messages.stream(
          {
            model: this.model,
            max_tokens: this.maxTokens,
            // Tools render before the system prompt, so a breakpoint on the
            // last system block caches both together. Both are constants for
            // the tenant, so this entry is shared by every concurrent call.
            system: [
              {
                type: "text",
                text: params.system,
                cache_control: { type: "ephemeral" },
              },
            ],
            messages: withCacheBreakpoint(
              toAnthropicMessages(params.history),
              params.context ?? "",
            ),
            ...(params.tools.length > 0 ? { tools: params.tools } : {}),
          },
          { signal: params.signal },
        );

        stream.on("text", (delta: string) => {
          for (const sentence of splitter.push(delta)) {
            sentenceQueue.push(sentence);
            notify();
          }
        });

        const message = await stream.finalMessage();
        logCacheUsage(message.usage);

        const tail = splitter.flush();
        if (tail) {
          sentenceQueue.push(tail);
          notify();
        }

        for (const block of message.content) {
          if (block.type === "tool_use") {
            collected.push({
              id: block.id,
              name: block.name,
              input: (block.input ?? {}) as Record<string, unknown>,
            });
          }
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
}

/**
 * Mark the end of the reusable conversation prefix, then put the volatile
 * per-turn context after it.
 *
 * The breakpoint goes on the last block of the transcript the model has already
 * seen, so the following turn reads the conversation so far back out of cache
 * instead of paying full input price for it a second time. Everything before
 * the breakpoint comes along: tools, system prompt, every earlier turn.
 *
 * Putting the breakpoint *before* the context rather than at the very end is
 * the whole trick. The other way round, the clock reading in the context would
 * be part of every cached prefix, no two turns would ever match, and the result
 * would be a write on every turn and a read on none.
 */
function withCacheBreakpoint(
  messages: Anthropic.MessageParam[],
  context: string,
): Anthropic.MessageParam[] {
  const out = [...messages];
  const last = out[out.length - 1];

  if (last) {
    const blocks: Anthropic.ContentBlockParam[] =
      typeof last.content === "string"
        ? [{ type: "text", text: last.content }]
        : [...last.content];

    // toAnthropicMessages only ever builds text and tool_result blocks, and
    // those are the two the narrowing needs: not every block type in the union
    // accepts cache_control, and a thinking block in particular does not.
    const tail = blocks[blocks.length - 1];
    if (tail && (tail.type === "text" || tail.type === "tool_result")) {
      blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
    }

    out[out.length - 1] = { ...last, content: blocks };
  }

  if (!context) return out;

  // The context has to be the last thing in the request, and content can only
  // hang off a user message, so an assistant-terminated history, or an empty
  // one on the opening turn, gets a fresh user turn to carry it.
  const tailMessage = out[out.length - 1];
  if (tailMessage?.role === "user" && Array.isArray(tailMessage.content)) {
    tailMessage.content.push({ type: "text", text: context });
  } else {
    out.push({ role: "user", content: [{ type: "text", text: context }] });
  }

  return out;
}

/**
 * Report cache effectiveness when NIGHTBELL_CACHE_STATS is set.
 *
 * Worth a switch, because a broken cache is silent by construction: the request
 * still succeeds and the reply is still correct, it just costs several times
 * what it should. If the read count stays at zero across a call, something
 * upstream is changing the prefix and the caching has become a surcharge.
 */
function logCacheUsage(usage: Anthropic.Usage): void {
  if (!process.env["NIGHTBELL_CACHE_STATS"]) return;
  console.log(
    `[cache] read ${usage.cache_read_input_tokens ?? 0}, ` +
      `written ${usage.cache_creation_input_tokens ?? 0}, ` +
      `uncached ${usage.input_tokens}`,
  );
}

/**
 * Fold our transcript shape into the Anthropic message format.
 *
 * Tool results have to be attached to a user-role message, and consecutive
 * turns of the same role must be merged, or the API rejects the request. Doing
 * it here keeps the rest of the codebase working in the simpler shape.
 */
function toAnthropicMessages(history: ConversationTurn[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  for (const turn of history) {
    if (turn.role === "tool_result") {
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: turn.toolUseId,
        content: turn.content,
      };
      const last = messages[messages.length - 1];
      if (last?.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        messages.push({ role: "user", content: [block] });
      }
      continue;
    }

    const last = messages[messages.length - 1];
    if (last?.role === turn.role && typeof last.content === "string") {
      last.content += ` ${turn.content}`;
    } else {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  return messages;
}
