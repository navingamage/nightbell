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
            system: params.system,
            messages: toAnthropicMessages(params.history),
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
