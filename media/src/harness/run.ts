/**
 * The offline call harness.
 *
 * Drives a real `Session` through a scripted call and prints the conversation,
 * the triage decisions, and the latency budget as it happens. Everything below
 * the session is faked — no phone number, no carrier, and by default no API
 * keys at all.
 *
 * The point is to make the parts of this system that are normally invisible
 * *watchable*. On a real call you hear a voice and have no idea which rule
 * fired, how long the caller waited, or what the model was told. Here all of it
 * is on screen next to the words that caused it.
 *
 *   npm run harness              # every scenario, faked model
 *   npm run harness sewage-2am   # one scenario
 *   npm run harness --live       # real Claude, needs ANTHROPIC_API_KEY
 */

import { encode } from "../call/audio.js";
import { type CallRecord, Session, type TenantConfig } from "../call/session.js";
import { ClaudeModel } from "../providers/claude.js";
import type {
  ConversationTurn,
  LanguageModel,
  ModelResponse,
  SpeechRecogniser,
  SpeechSynthesiser,
  ToolCall,
  ToolDefinition,
  Transcript,
} from "../providers/types.js";
import { nextField } from "../intake/schema.js";
import { SCENARIOS, type Scenario, findScenario } from "./scenarios.js";

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

const TENANT: TenantConfig = {
  tenantId: "t_demo",
  businessName: "Buckeye Restoration",
  serviceArea: "Austin and the surrounding counties",
  timezone: "America/Chicago",
  onCallNumber: "+15125550199",
  greeting: "Buckeye Restoration, this is the after-hours line. What's the best number to reach you on, in case we get cut off?",
};

/** Recogniser that emits whatever the script feeds it. */
class ScriptedRecogniser implements SpeechRecogniser {
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
class PrintingSynthesiser implements SpeechSynthesiser {
  lines: string[] = [];
  async *speak(text: string, signal: AbortSignal): AsyncIterable<Buffer> {
    this.lines.push(text);
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
 * A model stand-in that follows the intake script.
 *
 * Not an attempt to imitate Claude — it exists so the harness runs with no API
 * key and so the *deterministic* parts of the system (triage, endpointing,
 * booking gates, transfer paths) can be watched without model variance in the
 * way. Use --live to put the real model in.
 */
class ScriptedModel implements LanguageModel {
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

async function runScenario(scenario: Scenario, live: boolean): Promise<boolean> {
  const recogniser = new ScriptedRecogniser();
  const synthesiser = new PrintingSynthesiser();
  const model: LanguageModel = live
    ? new ClaudeModel({ apiKey: process.env["ANTHROPIC_API_KEY"] ?? "" })
    : new ScriptedModel();

  let saved: CallRecord | null = null;
  let transferredTo: string | null = null;
  let transferReason = "";

  /**
   * A stand-in for the carrier socket that also plays Twilio's part.
   *
   * Twilio sends a `mark` event back once the audio preceding it has actually
   * finished playing, and that event is the only thing that tells the turn
   * controller the agent has stopped talking. Swallowing it — as an inert fake
   * socket does — leaves the controller believing the agent is still speaking
   * forever, so every subsequent caller turn is classified as a barge-in, the
   * generation is aborted, and its tool calls are discarded. The intake then
   * silently collects nothing.
   *
   * Echoing the mark back is what makes this a fake of Twilio rather than a
   * fake of a socket.
   */
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

  const session = new Session({
    socket: socket as unknown as import("ws").WebSocket,
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

  deliverMark = (name) => session.onMark(name);

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

  for (const utterance of scenario.utterances) {
    if (transferredTo) break;

    console.log(`  ${C.yellow}caller${C.reset}  ${utterance}`);
    const startedAt = performance.now();

    // Loud frames open the turn, exactly as carrier audio would.
    const loud = encode(new Int16Array(160).fill(12000));
    for (let i = 0; i < 10; i++) session.onAudio(loud);
    recogniser.say(utterance);

    await settle();
    drain();

    const snapshot = session.snapshot;
    if (snapshot.triage.urgency !== previousUrgency) {
      const fired = snapshot.triage.hits.map((h) => h.ruleId).join(", ");
      console.log(
        `  ${C.red}${C.bold}⚡ ${snapshot.triage.urgency}${C.reset}${C.red} — ${fired}${C.reset}`,
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

/** Let the session's async work finish before inspecting it. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const wanted = args.find((a) => !a.startsWith("--"));

  if (live && !process.env["ANTHROPIC_API_KEY"]) {
    console.error("--live needs ANTHROPIC_API_KEY");
    process.exit(1);
  }

  const scenarios = wanted
    ? [findScenario(wanted)].filter((s): s is Scenario => Boolean(s))
    : SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`unknown scenario: ${wanted}`);
    console.error(`known: ${SCENARIOS.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  console.log(
    `${C.bold}nightbell harness${C.reset} ${C.dim}— ${scenarios.length} scenario(s), ` +
      `${live ? "live model" : "scripted model"}${C.reset}`,
  );

  let passed = 0;
  for (const scenario of scenarios) {
    if (await runScenario(scenario, live)) passed++;
  }

  console.log(`\n${C.bold}${"─".repeat(72)}${C.reset}`);
  const allPassed = passed === scenarios.length;
  console.log(
    `${allPassed ? C.green : C.red}${passed}/${scenarios.length} scenarios behaved as specified${C.reset}\n`,
  );
  process.exit(allPassed ? 0 : 1);
}

void main();
