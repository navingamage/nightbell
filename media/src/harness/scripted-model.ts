/**
 * A model stand-in that follows the intake script.
 *
 * Not an attempt to imitate a real model. It exists so the harness runs with no
 * API key, and so the *deterministic* parts of the system (triage, endpointing,
 * booking gates, transfer paths) can be watched without model variance in the
 * way. Use a real model to judge the conversation.
 */

import { nextField } from "../intake/schema.js";
import type {
  ConversationTurn,
  LanguageModel,
  ModelResponse,
  ToolCall,
  ToolDefinition,
} from "../providers/types.js";

export class ScriptedModel implements LanguageModel {
  private collected: Record<string, unknown> = {};
  /**
   * The session calls the model a second time after tool results come back, so
   * it can say something about them. A real model handles that naturally; this
   * stand-in has to remember which utterance it already filed, or it records
   * the same sentence against two different fields and the intake drifts one
   * question ahead of the caller.
   */
  private lastFiled = "";

  respond(params: {
    system: string;
    history: ConversationTurn[];
    tools: ToolDefinition[];
    signal: AbortSignal;
  }): ModelResponse {
    // The session calls the model again once tool results come back, so it can
    // say something about them. A real model says something new or says nothing.
    // This one, asked the same question twice, used to answer it twice, and the
    // caller heard the agent repeat itself verbatim. Staying quiet on the
    // follow-up is both simpler and closer to what a real turn sounds like.
    const last = params.history[params.history.length - 1];
    if (last?.role === "tool_result") return this.reply([], []);

    const lastUser = [...params.history].reverse().find((t) => t.role === "user");
    const heard = lastUser && "content" in lastUser ? lastUser.content : "";

    if (/talk to (an actual )?(a )?person|speak to someone|real human/i.test(heard)) {
      return this.reply(["Of course, let me get someone for you."], [
        { id: "t1", name: "transfer_to_human", input: { reason: "caller asked for a person" } },
      ]);
    }

    // Attribute the answer to whatever field was outstanding, then ask the next.
    const field = nextField(this.collected);
    const tools: ToolCall[] = [];
    if (field && heard && heard !== this.lastFiled) {
      this.collected[field.key] = heard;
      this.lastFiled = heard;
      tools.push({ id: `t_${field.key}`, name: "record_details", input: { [field.key]: heard } });
    }

    const upcoming = nextField(this.collected);
    const sentences = upcoming
      ? [acknowledge(heard), upcoming.prompt]
      : ["That's everything I need.", "Let me get this booked for you."];

    if (!upcoming) {
      tools.push({
        id: "t_book",
        name: "book_job",
        input: {
          confirmed_address: String(this.collected["property_address"] ?? ""),
          confirmed_callback: String(this.collected["callback_number"] ?? ""),
        },
      });
    }

    return this.reply(sentences.filter(Boolean), tools);
  }

  private reply(sentences: string[], tools: ToolCall[]): ModelResponse {
    return {
      sentences: (async function* () {
        for (const s of sentences) {
          await new Promise((r) => setTimeout(r, 90)); // token generation
          yield s;
        }
      })(),
      toolCalls: Promise.resolve(tools),
    };
  }
}

function acknowledge(heard: string): string {
  if (/sewer|sewage|septic/i.test(heard)) return "Okay, that's a serious one and I'm treating it as an emergency.";
  if (/still (coming|running|pouring)|can't stop/i.test(heard)) return "Understood, I'm getting someone out to you tonight.";
  if (/newborn|baby|infant/i.test(heard)) return "Thanks for telling me that, it changes how quickly we need to be there.";
  return "Got it.";
}
