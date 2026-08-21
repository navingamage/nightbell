/**
 * The offline call harness.
 *
 * Drives a real `Session` through a scripted call and prints the conversation,
 * the triage decisions, and the latency budget as it happens. Everything below
 * the session is faked: no phone number, no carrier, and by default no API
 * keys at all.
 *
 * The point is to make the parts of this system that are normally invisible
 * *watchable*. On a real call you hear a voice and have no idea which rule
 * fired, how long the caller waited, or what the model was told. Here all of it
 * is on screen next to the words that caused it.
 *
 *   npm run harness                      # every scenario, faked model
 *   npm run harness sewage-2am           # one scenario
 *   npm run harness --live               # a real model, needs OPENROUTER_API_KEY
 *   npm run harness --live --model=x/y   # a different model, same scenarios
 *   npm run harness --recorded           # only calls recorded from real sessions
 *   npm run harness --builtin            # only the six written scenarios
 *
 * `--live` reads the key from the environment or from `media/.env`. The model
 * defaults to OPENROUTER_MODEL, then to the provider's own default; running the
 * same six scenarios against a candidate is how a model gets chosen.
 */

import { type CallRecord, Session } from "../call/session.js";
import { loadDotEnv } from "../env.js";
import { DEFAULT_MODEL, OpenRouterModel } from "../providers/openrouter.js";
import type { LanguageModel } from "../providers/types.js";
import {
  PrintingSynthesiser,
  TENANT,
  TypedRecogniser,
  fakeCarrier,
  openTurn,
  settler,
} from "./fakes.js";
import { ScriptedModel } from "./scripted-model.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import { loadRecordings } from "./recordings.js";

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

async function runScenario(
  scenario: Scenario,
  live: boolean,
  modelName: string,
): Promise<boolean> {
  const recogniser = new TypedRecogniser();
  const synthesiser = new PrintingSynthesiser();
  // A scripted model answers in a fixed ~400ms; a real one does not, and a turn
  // that files a tool call costs two round trips. Wait for silence in that case
  // rather than paying the worst case on every turn of every scenario.
  const settle = live
    ? settler(synthesiser, { floorMs: 3_000, quietMs: 2_500 })
    : settler(synthesiser, { floorMs: 400, quietMs: 200 });
  const model: LanguageModel = live
    ? new OpenRouterModel({
        apiKey: process.env["OPENROUTER_API_KEY"] ?? "",
        model: modelName,
      })
    : new ScriptedModel();

  let saved: CallRecord | null = null;
  let transferredTo: string | null = null;
  let transferReason = "";

  const carrier = fakeCarrier();

  const session = new Session({
    socket: carrier.socket,
    streamSid: "MZ_harness",
    callSid: `CA_${scenario.id}`,
    tenant: TENANT,
    recogniser,
    synthesiser,
    model,
    persist: async (record) => {
      saved = record;
    },
    transfer: async (_sid, to, reason) => {
      transferredTo = to;
      transferReason = reason;
    },
  });

  carrier.onMark((name) => session.onMark(name));

  console.log(`\n${C.bold}${"─".repeat(72)}${C.reset}`);
  console.log(`${C.bold}${scenario.title}${C.reset}`);
  console.log(`${C.dim}${scenario.note}${C.reset}\n`);

  let spokenCount = 0;
  const drain = (): void => {
    for (const line of synthesiser.lines.slice(spokenCount)) {
      console.log(`  ${C.cyan}agent${C.reset}   ${line}`);
    }
    spokenCount = synthesiser.lines.length;
  };

  await session.start();
  drain();

  let previousUrgency = "routine";
  let previousFields = new Set<string>();

  /**
   * Two things that are wrong on every call, whatever the scenario expects.
   *
   * Silence, because a caller who gets no reply has no way to know the line is
   * still up, and on a real call the caller eventually said "hello?" into it.
   * And repetition, because an agent that asks the same question twice in a row
   * is the most obvious tell there is that nobody is listening.
   *
   * Neither is visible in the urgency or the outcome, which is why both calls
   * that produced them still passed their scenarios.
   */
  const manners: string[] = [];
  const askedBefore = new Set<string>();

  for (const utterance of scenario.utterances) {
    if (transferredTo) break;

    console.log(`  ${C.yellow}caller${C.reset}  ${utterance}`);
    const startedAt = performance.now();
    const spokenBefore = synthesiser.lines.length;

    openTurn((frame) => session.onAudio(frame));
    recogniser.say(utterance);

    await settle();
    drain();

    const thisTurn = synthesiser.lines.slice(spokenBefore);
    if (thisTurn.length === 0 && !transferredTo) {
      manners.push(`said nothing after "${utterance}"`);
    }
    const seen = new Set<string>();
    for (const line of thisTurn) {
      const key = line.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
      // Any line twice in one turn, or any *question* twice in the call. An
      // acknowledgement repeating across turns is what people actually sound
      // like; a question repeating is not.
      if (seen.has(key) || (line.trimEnd().endsWith("?") && askedBefore.has(key))) {
        manners.push(`repeated "${line}" word for word`);
      }
      seen.add(key);
      if (line.trimEnd().endsWith("?")) askedBefore.add(key);
    }

    const snapshot = session.snapshot;

    // What the model actually filed this turn. On a live run this is the first
    // thing to look at when the agent asks a question the caller already
    // answered: the intake only advances through record_details, so a turn that
    // files nothing is a turn the model heard and dropped.
    const filed = Object.entries(snapshot.collected).filter(([key]) => !previousFields.has(key));
    for (const [key, value] of filed) {
      console.log(`  ${C.blue}filed${C.reset}   ${C.dim}${key} = ${JSON.stringify(value)}${C.reset}`);
    }
    previousFields = new Set(Object.keys(snapshot.collected));

    if (snapshot.triage.urgency !== previousUrgency) {
      const fired = snapshot.triage.hits.map((h) => h.ruleId).join(", ");
      console.log(
        `  ${C.red}${C.bold}⚡ ${snapshot.triage.urgency}${C.reset}${C.red}: ${fired}${C.reset}`,
      );
      for (const hit of snapshot.triage.hits) {
        console.log(`     ${C.dim}"${hit.evidence}" → ${hit.reason}${C.reset}`);
      }
      previousUrgency = snapshot.triage.urgency;
    }

    const elapsed = Math.round(performance.now() - startedAt);
    console.log(`  ${C.dim}${elapsed}ms to first audio${C.reset}\n`);
  }

  // A tool result prompts the session to call the model again, so the last turn
  // is still unwinding when the loop ends. Wait for it before judging.
  await settle();
  drain();

  // Read the outcome before closing. close() marks an unfinished call
  // "abandoned", which is right on a real call that hung up but would hide what
  // the scenario actually reached.
  const urgency = session.snapshot.triage.urgency;
  const outcome = session.snapshot.outcome;

  if (!transferredTo) await session.close();
  else await settle();
  void (saved as CallRecord | null);

  if (transferredTo) {
    console.log(`  ${C.magenta}→ transferred to ${transferredTo}${C.reset}`);
    console.log(`    ${C.dim}${transferReason}${C.reset}\n`);
  }

  const firedRules = new Set(session.snapshot.triage.hits.map((h) => h.ruleId));
  const problems: string[] = [];
  if (urgency !== scenario.expect.urgency) {
    problems.push(`urgency: expected ${scenario.expect.urgency}, got ${urgency}`);
  }
  if (outcome !== scenario.expect.outcome) {
    problems.push(`outcome: expected ${scenario.expect.outcome}, got ${outcome}`);
  }
  for (const rule of scenario.expect.rules ?? []) {
    if (!firedRules.has(rule)) problems.push(`rule ${rule} did not fire`);
  }
  problems.push(...manners);

  const latencies = session.snapshot.turnLatenciesMs;
  if (latencies.length > 0) {
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    const worst = Math.max(...latencies);
    console.log(`  ${C.dim}first audio: ${avg}ms average, ${worst}ms worst${C.reset}`);
  }

  if (problems.length === 0) {
    console.log(`  ${C.green}✓ ${urgency} / ${outcome}${C.reset}`);
    return true;
  }
  for (const problem of problems) console.log(`  ${C.red}✗ ${problem}${C.reset}`);
  return false;
}

async function main(): Promise<void> {
  loadDotEnv();

  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const wanted = args.find((a) => !a.startsWith("--"));

  if (live && !process.env["OPENROUTER_API_KEY"]) {
    console.error("--live needs OPENROUTER_API_KEY");
    process.exit(1);
  }

  const modelName =
    args.find((a) => a.startsWith("--model="))?.slice("--model=".length) ||
    process.env["OPENROUTER_MODEL"] ||
    DEFAULT_MODEL;

  // Recorded calls are scenarios with provenance, so they run through exactly
  // the same path. A malformed one throws rather than being skipped: a
  // regression test that quietly stops running still reports green.
  const recorded = await loadRecordings();
  const known = args.includes("--recorded")
    ? recorded
    : args.includes("--builtin")
      ? SCENARIOS
      : [...SCENARIOS, ...recorded];

  const scenarios = wanted
    ? known.filter((s) => s.id === wanted)
    : known;

  if (scenarios.length === 0) {
    if (wanted) {
      console.error(`unknown scenario: ${wanted}`);
      console.error(`known: ${known.map((s) => s.id).join(", ")}`);
    } else {
      console.error("no scenarios to run");
    }
    process.exit(1);
  }

  console.log(
    `${C.bold}nightbell harness${C.reset} ${C.dim}${scenarios.length} scenario(s), ` +
      `${live ? modelName : "scripted model"}${C.reset}`,
  );

  let passed = 0;
  for (const scenario of scenarios) {
    if (await runScenario(scenario, live, modelName)) passed++;
  }

  console.log(`\n${C.bold}${"─".repeat(72)}${C.reset}`);
  const allPassed = passed === scenarios.length;
  console.log(
    `${allPassed ? C.green : C.red}${passed}/${scenarios.length} scenarios behaved as specified${C.reset}\n`,
  );
  process.exit(allPassed ? 0 : 1);
}

void main();
