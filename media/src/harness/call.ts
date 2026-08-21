/**
 * Take the call yourself.
 *
 * The scripted harness proves the system does what it is specified to do. This
 * one is for finding out what it is actually like, which a fixed script cannot
 * tell you: whether the agent asks the next question a person would ask,
 * whether it copes with an answer to a question it did not ask, whether being
 * evasive or panicky or chatty at it breaks anything.
 *
 *   npm run call                     # real model, needs OPENROUTER_API_KEY
 *   npm run call -- --model=x/y      # a different model
 *   npm run call -- --scripted       # no key, no spend, the stand-in model
 *
 * You type what the caller says. Everything the agent does is printed beside
 * it: which triage rule fired and on which words, what it filed and under which
 * field, and how long the caller waited for the first audio. Ending the call
 * prints the ticket a technician would be handed.
 *
 * The only thing faked above the session is your voice. Below it, the same
 * `Session` runs that a Twilio socket would drive, including the turn-taking
 * and the mark accounting.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { type CallRecord, Session } from "../call/session.js";
import { loadDotEnv } from "../env.js";
import { REQUIRED_KEYS } from "../call/session.js";
import { DEFAULT_MODEL, OpenRouterModel } from "../providers/openrouter.js";
import type { LanguageModel } from "../providers/types.js";
import { ScriptedModel } from "./scripted-model.js";
import {
  PrintingSynthesiser,
  TENANT,
  TypedRecogniser,
  fakeCarrier,
  openTurn,
  settler,
} from "./fakes.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

async function main(): Promise<void> {
  loadDotEnv();

  const args = process.argv.slice(2);
  const scripted = args.includes("--scripted");
  const modelName =
    args.find((a) => a.startsWith("--model="))?.slice("--model=".length) ||
    process.env["OPENROUTER_MODEL"] ||
    DEFAULT_MODEL;

  if (!scripted && !process.env["OPENROUTER_API_KEY"]) {
    console.error("needs OPENROUTER_API_KEY, or pass --scripted to use the stand-in model");
    process.exit(1);
  }

  const model: LanguageModel = scripted
    ? new ScriptedModel()
    : new OpenRouterModel({ apiKey: process.env["OPENROUTER_API_KEY"] ?? "", model: modelName });

  const recogniser = new TypedRecogniser();
  const synthesiser = new PrintingSynthesiser();
  const carrier = fakeCarrier();
  // Shorter than the scripted harness waits, because a person sitting at a
  // prompt notices the pause and a test runner does not.
  const settle = settler(synthesiser, { floorMs: 600, quietMs: 1_400 });

  let spokenCount = 0;
  const drain = (): void => {
    for (const line of synthesiser.lines.slice(spokenCount)) {
      console.log(`  ${C.cyan}agent${C.reset}   ${line}`);
    }
    spokenCount = synthesiser.lines.length;
  };

  let saved: CallRecord | null = null;
  let transferred = "";

  const session = new Session({
    socket: carrier.socket,
    streamSid: "MZ_interactive",
    callSid: `CA_interactive_${process.pid}`,
    tenant: TENANT,
    recogniser,
    synthesiser,
    model,
    persist: async (record) => {
      saved = record;
    },
    transfer: async (_sid, to, reason) => {
      transferred = `${to}: ${reason}`;
    },
  });
  carrier.onMark((name) => session.onMark(name));

  console.log(
    `\n${C.bold}nightbell${C.reset} ${C.dim}${scripted ? "scripted model" : modelName}${C.reset}`,
  );
  console.log(
    `${C.dim}You are the caller. Type what you would say. ` +
      `Ctrl-D or an empty line hangs up.${C.reset}\n`,
  );

  await session.start();
  drain();

  const rl = createInterface({ input: stdin, output: stdout });
  let previousUrgency = "routine";
  let previousFields = new Set<string>();

  for (;;) {
    if (transferred) break;

    // Ctrl-D closes stdin, and a closed readline throws rather than resolving.
    // That is a hang-up, which is a perfectly ordinary way for a call to end.
    let said: string;
    try {
      said = (await rl.question(`  ${C.yellow}caller${C.reset}  `)).trim();
    } catch {
      break;
    }
    if (!said) break;

    const startedAt = performance.now();
    openTurn((frame) => session.onAudio(frame));
    recogniser.say(said);

    await settle();
    drain();

    const snapshot = session.snapshot;

    for (const [key, value] of Object.entries(snapshot.collected)) {
      if (previousFields.has(key)) continue;
      console.log(`  ${C.blue}filed${C.reset}   ${C.dim}${key} = ${JSON.stringify(value)}${C.reset}`);
    }
    previousFields = new Set(Object.keys(snapshot.collected));

    if (snapshot.triage.urgency !== previousUrgency) {
      console.log(
        `  ${C.red}${C.bold}⚡ ${snapshot.triage.urgency}${C.reset}` +
          `${C.red}: ${snapshot.triage.hits.map((h) => h.ruleId).join(", ")}${C.reset}`,
      );
      for (const hit of snapshot.triage.hits) {
        console.log(`     ${C.dim}"${hit.evidence}" → ${hit.reason}${C.reset}`);
      }
      previousUrgency = snapshot.triage.urgency;
    }

    const latencies = snapshot.turnLatenciesMs;
    const last = latencies[latencies.length - 1];
    if (last !== undefined) console.log(`  ${C.dim}${last}ms to first audio${C.reset}\n`);
    else console.log("");
  }

  rl.close();

  if (transferred) {
    console.log(`\n  ${C.magenta}→ transferred to ${transferred}${C.reset}`);
  }

  // Read the outcome before closing: close() marks an unfinished call abandoned,
  // which is right for a caller who hung up but would hide where this one got to.
  const outcome = session.snapshot.outcome;
  const urgency = session.snapshot.triage.urgency;
  const collected = session.snapshot.collected;
  const latencies = session.snapshot.turnLatenciesMs;
  await session.close();
  void (saved as CallRecord | null);

  printTicket({ outcome, urgency, collected, latencies });
}

/** The ticket, which is the only part of this a contractor ever sees. */
function printTicket(call: {
  outcome: string;
  urgency: string;
  collected: Record<string, unknown>;
  latencies: number[];
}): void {
  console.log(`\n${C.bold}${"─".repeat(60)}${C.reset}`);
  console.log(`${C.bold}Ticket${C.reset}  ${call.urgency} / ${call.outcome}\n`);

  const missing: string[] = [];
  for (const key of REQUIRED_KEYS) {
    const value = call.collected[key];
    if (value === undefined || value === "") {
      missing.push(key);
      continue;
    }
    console.log(`  ${key.padEnd(18)} ${String(value)}`);
  }
  for (const [key, value] of Object.entries(call.collected)) {
    if (!REQUIRED_KEYS.includes(key as (typeof REQUIRED_KEYS)[number])) {
      console.log(`  ${C.dim}${key.padEnd(18)} ${String(value)}${C.reset}`);
    }
  }
  if (missing.length > 0) {
    console.log(`\n  ${C.red}still needed: ${missing.join(", ")}${C.reset}`);
  }

  if (call.latencies.length > 0) {
    const avg = Math.round(call.latencies.reduce((a, b) => a + b, 0) / call.latencies.length);
    console.log(
      `\n  ${C.dim}first audio: ${avg}ms average, ${Math.max(...call.latencies)}ms worst${C.reset}`,
    );
  }
  console.log("");
}

void main();
