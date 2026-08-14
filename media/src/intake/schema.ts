/**
 * What a restoration job ticket has to contain before a technician will roll.
 *
 * This is the domain knowledge that makes the difference between a voice agent
 * and a useful one. A generic "AI receptionist" takes a name and a number and
 * leaves the contractor to call back and conduct the real conversation — which
 * means the agent saved nobody any time. The point of picking a single vertical
 * is that the intake can be the *actual* intake: by the time the call ends,
 * the on-call technician knows whether to bring an extraction truck or a
 * dehumidifier, and the office knows which insurer to bill.
 *
 * Each field carries the endpointing profile the turn controller should use
 * while waiting for its answer, because the shape of the expected reply is
 * known here and nowhere else. Asking "is the water still running?" and then
 * waiting 1.1 seconds of silence to be sure the caller finished saying "yes"
 * is the single most common way these systems feel slow.
 */

import type { EndpointProfile } from "../call/turn.js";

export type FieldKind = "text" | "phone" | "address" | "enum" | "boolean" | "number";

export interface IntakeField {
  key: string;
  /** How the agent asks for it. Phrased for speech, not for a form label. */
  prompt: string;
  kind: FieldKind;
  /** Endpointing patience while waiting for this answer. */
  endpoint: EndpointProfile;
  /** A job cannot be booked without this. */
  required: boolean;
  options?: string[];
  /**
   * Skip the question when this returns true — usually because the answer is
   * already known from what the caller volunteered, or because it is moot.
   */
  skipIf?: (collected: Record<string, unknown>) => boolean;
}

/**
 * The script, in the order a person would actually ask.
 *
 * Callback number comes first and deliberately early. Restoration calls drop —
 * people are standing in wet basements on failing phones — and a call that
 * drops after thirty seconds is worthless unless there is a number to ring
 * back. Everything else is recoverable; a lost caller is not.
 */
export const INTAKE_FIELDS: IntakeField[] = [
  {
    key: "callback_number",
    prompt: "What's the best number to reach you on, in case we get cut off?",
    kind: "phone",
    endpoint: "detail",
    required: true,
  },
  {
    key: "caller_name",
    prompt: "And who am I speaking with?",
    kind: "text",
    endpoint: "detail",
    required: true,
  },
  {
    key: "situation",
    prompt: "Tell me what's happening.",
    kind: "text",
    // The one genuinely open question. Callers front-load the important
    // details here, and interrupting the answer is how you lose them.
    endpoint: "open",
    required: true,
  },
  {
    key: "property_address",
    prompt: "What's the address of the property?",
    kind: "address",
    endpoint: "detail",
    required: true,
  },
  {
    key: "property_type",
    prompt: "Is that a home or a commercial building?",
    kind: "enum",
    options: ["residential", "commercial"],
    endpoint: "terse",
    required: true,
  },
  {
    key: "water_still_active",
    prompt: "Is the water still coming in, or has it stopped?",
    kind: "boolean",
    endpoint: "terse",
    required: true,
  },
  {
    key: "source",
    prompt: "Do you know where it's coming from?",
    kind: "text",
    endpoint: "detail",
    required: true,
  },
  {
    key: "started_when",
    prompt: "Roughly when did this start?",
    kind: "text",
    endpoint: "detail",
    required: true,
  },
  {
    key: "affected_areas",
    prompt: "Which rooms or areas have water in them?",
    kind: "text",
    endpoint: "detail",
    required: true,
  },
  {
    key: "standing_water",
    prompt: "Is there standing water, and if so, roughly how deep?",
    kind: "text",
    endpoint: "detail",
    required: false,
  },
  {
    key: "insurance_carrier",
    prompt: "Are you planning to put this through insurance? If so, who's the carrier?",
    kind: "text",
    endpoint: "detail",
    required: false,
  },
  {
    key: "claim_number",
    prompt: "Do you have a claim number yet?",
    kind: "text",
    endpoint: "detail",
    required: false,
    // Nobody has a claim number if they have not called their insurer, and
    // asking anyway makes the agent sound like it is not listening.
    skipIf: (c) => !c["insurance_carrier"],
  },
  {
    key: "access",
    prompt: "If our crew comes out, will someone be there to let them in?",
    kind: "text",
    endpoint: "detail",
    required: true,
  },
];

/** Fields that must be filled before a job can be booked. */
export const REQUIRED_KEYS: readonly string[] = INTAKE_FIELDS.filter((f) => f.required).map(
  (f) => f.key,
);

/** The next question to ask, or null when the intake is complete. */
export function nextField(collected: Record<string, unknown>): IntakeField | null {
  for (const field of INTAKE_FIELDS) {
    if (collected[field.key] !== undefined && collected[field.key] !== null) continue;
    if (field.skipIf?.(collected)) continue;
    return field;
  }
  return null;
}

/** Required fields still outstanding. */
export function missingRequired(collected: Record<string, unknown>): string[] {
  return REQUIRED_KEYS.filter((key) => {
    const value = collected[key];
    return value === undefined || value === null || value === "";
  });
}

export function isBookable(collected: Record<string, unknown>): boolean {
  return missingRequired(collected).length === 0;
}

/**
 * Normalise a spoken phone number into digits.
 *
 * Speech recognisers return phone numbers in wildly inconsistent shapes —
 * "five one two", "512", "5 1 2" — and sometimes with a spelled-out area code
 * next to a digit-grouped exchange. This does not try to be clever about
 * validation; it collects digits and lets the caller confirm the read-back,
 * because a human confirming is more reliable than any parser.
 */
const SPOKEN_DIGITS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

export function normalisePhone(spoken: string): string {
  const words = spoken.toLowerCase().split(/[\s-]+/);
  let digits = "";
  for (const word of words) {
    const mapped = SPOKEN_DIGITS[word];
    if (mapped) {
      digits += mapped;
      continue;
    }
    digits += word.replace(/\D/g, "");
  }
  // Drop a leading country code so read-back matches how people say it.
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** Format for reading a number back to the caller, grouped as people say it. */
export function speakPhone(digits: string): string {
  if (digits.length !== 10) return digits.split("").join(" ");
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}
