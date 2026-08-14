/**
 * The tools the model may call, and the system prompt that governs it.
 *
 * Note what is deliberately absent: there is no `set_urgency` tool and no
 * `decide_if_emergency` tool. The model can *report* how urgent it thinks a
 * call is, through `record_details`, and applyModelOpinion() in triage.ts will
 * take that as a vote that can only escalate. It cannot lower an escalation the
 * rules made. Giving a model a tool named `set_urgency` would quietly hand it
 * the authority this system is built to withhold.
 */

import type { ToolDefinition } from "../providers/types.js";
import { INTAKE_FIELDS } from "./schema.js";

export const RECORD_DETAILS: ToolDefinition = {
  name: "record_details",
  description:
    "Record facts the caller has given you. Call this as soon as you learn something, " +
    "even mid-conversation, and even if you only learned one field. Never wait until " +
    "the end of the call. Only include fields the caller actually stated — do not guess " +
    "or fill in plausible values.",
  input_schema: {
    type: "object",
    properties: {
      ...Object.fromEntries(
        INTAKE_FIELDS.map((field) => [
          field.key,
          {
            type: field.kind === "boolean" ? "boolean" : "string",
            description: field.prompt,
            ...(field.options ? { enum: field.options } : {}),
          },
        ]),
      ),
      urgency_opinion: {
        type: "string",
        enum: ["routine", "priority", "dispatch_now", "transfer_human"],
        description:
          "How urgent this sounds to you. This is advisory only: it can raise the " +
          "urgency the system already determined, never lower it.",
      },
    },
  },
};

export const BOOK_JOB: ToolDefinition = {
  name: "book_job",
  description:
    "Book the job once every required detail has been collected and read back to the " +
    "caller. Returns the arrival window to tell them. Do not call this before you have " +
    "confirmed the address and the callback number by reading them back.",
  input_schema: {
    type: "object",
    properties: {
      confirmed_address: {
        type: "string",
        description: "The address exactly as you read it back and the caller confirmed it.",
      },
      confirmed_callback: {
        type: "string",
        description: "The callback number the caller confirmed.",
      },
    },
    required: ["confirmed_address", "confirmed_callback"],
  },
};

export const TRANSFER_TO_HUMAN: ToolDefinition = {
  name: "transfer_to_human",
  description:
    "Hand the call to the on-call person immediately. Use this whenever the caller asks " +
    "for a person, is distressed beyond what you can help with, or describes something " +
    "outside water damage restoration. Transferring is always an acceptable outcome; " +
    "never talk a caller out of wanting one.",
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why the transfer is happening, for the call log." },
    },
    required: ["reason"],
  },
};

export const ALL_TOOLS: ToolDefinition[] = [RECORD_DETAILS, BOOK_JOB, TRANSFER_TO_HUMAN];

export interface PromptContext {
  businessName: string;
  /** Local time as the caller experiences it, e.g. "2:14 AM". */
  localTime: string;
  serviceArea: string;
  /** Fields still outstanding, so the model knows what to steer toward. */
  missing: string[];
  /** Set when deterministic triage has already escalated this call. */
  escalation?: { urgency: string; reasons: string[] };
}

/**
 * Build the system prompt.
 *
 * Two things in here are doing most of the work. The first is the instruction
 * to speak in short sentences: a caller on a phone cannot skim, and a
 * paragraph read aloud is unbearable. The second is the explicit permission to
 * transfer — the failure mode of a helpful model is that it keeps trying, and
 * on a 2am flood call the right answer is very often a human.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const lines = [
    `You answer the phone for ${ctx.businessName}, a water damage restoration company serving ${ctx.serviceArea}.`,
    `It is currently ${ctx.localTime} where the caller is.`,
    "",
    "You are talking to someone on a phone, out loud. That governs everything:",
    "- Speak in short sentences. One idea per sentence.",
    "- Never use lists, headings, markdown, or emoji. They cannot be heard.",
    "- Say numbers the way people say them: 'five one two, five five five, one two three four'.",
    "- Do not say your name is an AI unless asked directly. If asked, say so plainly and move on.",
    "",
    "Your job is to find out what happened and get a technician sent, or get the job booked.",
    "Callers are often upset and standing in water. Be calm, brief, and specific.",
    "Acknowledge what they said before asking the next thing.",
    "Ask one question at a time. Never stack two questions into one turn.",
    "",
    "Call record_details the moment you learn anything, not at the end.",
    "Read the address and callback number back before booking, and only book after they confirm.",
    "",
    "If the caller asks for a person, transfer immediately. Do not try to handle it yourself.",
    "If anything sounds like a safety emergency, transfer. Never reassure someone that a hazard is fine.",
  ];

  if (ctx.missing.length > 0) {
    lines.push("", `Still needed: ${ctx.missing.join(", ")}.`);
  }

  if (ctx.escalation) {
    lines.push(
      "",
      `This call has already been classified as ${ctx.escalation.urgency} because: ${ctx.escalation.reasons.join("; ")}.`,
      "Treat that as settled fact. Do not reassess it and do not tell the caller it might be less serious than it is.",
    );
  }

  return lines.join("\n");
}
