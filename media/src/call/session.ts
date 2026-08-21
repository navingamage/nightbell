/**
 * One live call.
 *
 * This is the orchestrator: it owns the carrier socket, the recogniser, the
 * synthesiser, the model, the turn controller, and the intake state, and it is
 * responsible for the ordering guarantees between them. Everything it does is
 * in service of two properties:
 *
 *   1. **A caller can always interrupt.** Barge-in aborts model generation,
 *      abandons synthesis, and clears the carrier's queue, in that order.
 *
 *   2. **Urgency is never the model's decision.** Every caller utterance goes
 *      through triage.ts before the model sees it, and the resulting
 *      classification is injected into the prompt as settled fact.
 *
 * The state lives in plain fields rather than a framework because a call is
 * short-lived, single-threaded, and needs to be readable at 3am when a
 * contractor is asking why their phone rang.
 */

import type { WebSocket } from "ws";
import { REQUIRED_KEYS, isBookable, missingRequired, nextField } from "../intake/schema.js";
import { ALL_TOOLS, buildSystemPrompt, buildTurnContext } from "../intake/tools.js";
import { type TriageResult, applyModelOpinion, triage } from "../intake/triage.js";
import type {
  ConversationTurn,
  LanguageModel,
  SpeechRecogniser,
  SpeechSynthesiser,
  ToolCall,
} from "../providers/types.js";
import { Playback } from "./playback.js";
import { TurnController } from "./turn.js";
import { clearMessage, markMessage, mediaMessage } from "./twilio.js";

export interface TenantConfig {
  tenantId: string;
  businessName: string;
  serviceArea: string;
  timezone: string;
  /** Number to bridge to when a call must reach a person. */
  onCallNumber: string;
  greeting: string;
}

export interface CallRecord {
  callSid: string;
  tenantId: string;
  startedAt: string;
  endedAt?: string;
  transcript: Array<{ speaker: "caller" | "agent"; text: string; at: number }>;
  collected: Record<string, unknown>;
  triage: TriageResult;
  outcome: "booked" | "transferred" | "abandoned" | "in_progress";
  /** Per-turn latency samples, for the numbers in docs/latency.md. */
  turnLatenciesMs: number[];
}

export interface SessionDeps {
  socket: WebSocket;
  streamSid: string;
  callSid: string;
  tenant: TenantConfig;
  recogniser: SpeechRecogniser;
  synthesiser: SpeechSynthesiser;
  model: LanguageModel;
  /** Persist the finished call to the control plane. */
  persist(record: CallRecord): Promise<void>;
  /** Bridge the caller to a human. */
  transfer(callSid: string, toNumber: string, reason: string): Promise<void>;
}

export class Session {
  private readonly turn: TurnController;
  private readonly playback: Playback;
  private readonly record: CallRecord;
  private history: ConversationTurn[] = [];
  private collected: Record<string, unknown> = {};
  private triageState: TriageResult = triage("");
  /** Aborts the in-flight model + synthesis pair when the caller interrupts. */
  private generation: AbortController | null = null;
  private turnStartedAt = 0;
  private closed = false;

  constructor(private readonly deps: SessionDeps) {
    this.playback = new Playback({
      sendFrame: (frame) => this.send(mediaMessage(deps.streamSid, frame)),
      clear: () => this.send(clearMessage(deps.streamSid)),
    });

    this.turn = new TurnController({
      onCallerTurnEnd: (utterance) => void this.handleCallerTurn(utterance),
      onBargeIn: () => this.handleBargeIn(),
    });

    this.record = {
      callSid: deps.callSid,
      tenantId: deps.tenant.tenantId,
      startedAt: new Date().toISOString(),
      transcript: [],
      collected: this.collected,
      triage: this.triageState,
      outcome: "in_progress",
      turnLatenciesMs: [],
    };

    deps.recogniser.onTranscript((t) => {
      this.turn.pushTranscript(t.text, t.isFinal);
      // The recogniser's own endpoint is better informed than raw energy, so
      // act on it when it fires — turn.ts keeps energy as the backstop.
      if (t.speechFinal) this.turn.closeTurn();
    });

    deps.recogniser.onError((err) => this.fail(err));
  }

  /** Speak the greeting and start listening. */
  async start(): Promise<void> {
    await this.say(this.deps.tenant.greeting);
  }

  /** Feed one inbound audio frame from the carrier. */
  onAudio(ulaw: Buffer): void {
    if (this.closed) return;
    this.deps.recogniser.write(ulaw);
    this.turn.pushFrame(ulaw);
  }

  /** Twilio reports that a marked point in the audio has finished playing. */
  onMark(name: string): void {
    if (name === "utterance-end") this.turn.agentStoppedSpeaking();
  }

  private send(message: string): void {
    if (this.closed) return;
    if (this.deps.socket.readyState === this.deps.socket.OPEN) {
      this.deps.socket.send(message);
    }
  }

  /**
   * The caller interrupted.
   *
   * Order matters. Abort generation first so nothing new is produced, then stop
   * playback, which clears the carrier's queue. Reversed, a chunk generated
   * between the clear and the abort would be sent *after* the flush and play
   * over the caller — the exact artefact this is here to prevent.
   */
  private handleBargeIn(): void {
    this.generation?.abort();
    this.generation = null;
    this.playback.stop();
  }

  /** Run one caller turn: triage, then model, then speak. */
  private async handleCallerTurn(utterance: string): Promise<void> {
    if (this.closed) return;

    this.turnStartedAt = performance.now();
    this.record.transcript.push({ speaker: "caller", text: utterance, at: Date.now() });
    this.history.push({ role: "user", content: utterance });

    // Triage runs over the whole call so far, not just this utterance: a hazard
    // mentioned in sentence one must not decay by sentence five.
    const fullTranscript = this.record.transcript
      .filter((t) => t.speaker === "caller")
      .map((t) => t.text)
      .join(" ");
    this.triageState = triage(fullTranscript);
    this.record.triage = this.triageState;

    if (this.triageState.requiresHuman) {
      await this.transferToHuman(
        this.triageState.hits.map((h) => h.reason).join("; ") || "safety escalation",
      );
      return;
    }

    this.turn.agentThinking();
    await this.generateReply();
  }

  /**
   * How many times one caller turn may bounce between the model and its tools.
   *
   * Tool results feed straight back into the model so it can say something
   * about them, and a model that answers with another tool call gets another
   * round. Nothing in that loop is guaranteed to terminate: a cheap model that
   * keeps filing the same field re-asks the same question forever, and because
   * every lap synthesises speech the caller hears the question over and over
   * while the turn never yields. Observed on a live run, forty-eight seconds
   * into a single turn.
   *
   * Three laps is more than a real intake turn needs. A caller who says their
   * name, the address and that the water is still running in one breath files
   * three fields in one call, not three rounds.
   */
  private static readonly MAX_TOOL_ROUNDS = 3;

  private async generateReply(round = 0): Promise<void> {
    const controller = new AbortController();
    this.generation = controller;

    // Split deliberately: `prompt` is identical on every turn of every call for
    // this tenant and can be cached, `context` is re-derived each turn and
    // cannot. See buildSystemPrompt() for why that split is load-bearing.
    const prompt = buildSystemPrompt({
      businessName: this.deps.tenant.businessName,
      serviceArea: this.deps.tenant.serviceArea,
    });

    const context = buildTurnContext({
      localTime: new Date().toLocaleTimeString("en-US", {
        timeZone: this.deps.tenant.timezone,
        hour: "numeric",
        minute: "2-digit",
      }),
      missing: missingRequired(this.collected),
      ...(this.triageState.urgency !== "routine"
        ? {
            escalation: {
              urgency: this.triageState.urgency,
              reasons: this.triageState.hits.map((h) => h.reason),
            },
          }
        : {}),
    });

    const response = this.deps.model.respond({
      system: prompt,
      context,
      history: this.history,
      tools: ALL_TOOLS,
      signal: controller.signal,
    });

    // Set endpointing for the answer we are about to invite, before the
    // question is even finished playing — the caller may start replying early.
    const upcoming = nextField(this.collected);
    if (upcoming) this.turn.setEndpointProfile(upcoming.endpoint);

    let spoken = "";
    let firstAudioAt = 0;

    try {
      this.turn.agentStartedSpeaking();
      for await (const sentence of response.sentences) {
        if (controller.signal.aborted) break;
        if (!firstAudioAt) {
          firstAudioAt = performance.now();
          this.record.turnLatenciesMs.push(Math.round(firstAudioAt - this.turnStartedAt));
        }
        spoken += (spoken ? " " : "") + sentence;
        await this.playback.play(
          this.deps.synthesiser.speak(sentence, controller.signal),
          controller.signal,
        );
      }

      if (spoken && !controller.signal.aborted) {
        this.history.push({ role: "assistant", content: spoken });
        this.record.transcript.push({ speaker: "agent", text: spoken, at: Date.now() });
      }

      const calls = await response.toolCalls;
      if (!controller.signal.aborted && calls.length > 0) {
        await this.runTools(calls, round);
      }
    } catch (err) {
      if (!controller.signal.aborted) this.fail(err instanceof Error ? err : new Error(String(err)));
      return;
    } finally {
      if (this.generation === controller) this.generation = null;
    }

    this.playback.flush();
    this.send(markMessage(this.deps.streamSid, "utterance-end"));
  }

  private async runTools(calls: ToolCall[], round: number): Promise<void> {
    for (const call of calls) {
      switch (call.name) {
        case "record_details": {
          const { urgency_opinion, ...fields } = call.input as Record<string, unknown> & {
            urgency_opinion?: string;
          };
          for (const [key, value] of Object.entries(fields)) {
            if (value !== undefined && value !== null && value !== "") {
              this.collected[key] = value;
            }
          }
          if (urgency_opinion) {
            // Advisory only — applyModelOpinion cannot lower the rules' verdict.
            this.triageState = applyModelOpinion(
              this.triageState,
              urgency_opinion as TriageResult["urgency"],
            );
            this.record.triage = this.triageState;
          }
          this.history.push({
            role: "tool_result",
            toolUseId: call.id,
            content: JSON.stringify({
              recorded: Object.keys(fields),
              still_needed: missingRequired(this.collected),
            }),
          });
          break;
        }

        case "book_job": {
          if (!isBookable(this.collected)) {
            // The model tried to book early. Tell it what is missing rather
            // than booking an incomplete ticket a technician cannot act on.
            this.history.push({
              role: "tool_result",
              toolUseId: call.id,
              content: JSON.stringify({
                booked: false,
                error: "missing required fields",
                still_needed: missingRequired(this.collected),
              }),
            });
            break;
          }
          this.record.outcome = "booked";
          this.history.push({
            role: "tool_result",
            toolUseId: call.id,
            content: JSON.stringify({
              booked: true,
              urgency: this.triageState.urgency,
              arrival_window:
                this.triageState.urgency === "dispatch_now" ? "60 to 90 minutes" : "tomorrow morning",
            }),
          });
          break;
        }

        case "transfer_to_human": {
          const reason = String(call.input["reason"] ?? "caller requested a person");
          await this.transferToHuman(reason);
          return;
        }
      }
    }

    // Tool results are new information; let the model say something about them.
    // Only up to the round cap: past that the turn has stopped converging, and
    // the right move is to stop talking and let the caller speak.
    if (!this.closed && this.record.outcome === "in_progress") {
      if (round + 1 >= Session.MAX_TOOL_ROUNDS) {
        console.warn(`[${this.deps.callSid}] tool round cap reached, yielding the turn`);
        return;
      }
      await this.generateReply(round + 1);
    }
  }

  private async transferToHuman(reason: string): Promise<void> {
    this.handleBargeIn();
    this.record.outcome = "transferred";
    try {
      await this.deps.transfer(this.deps.callSid, this.deps.tenant.onCallNumber, reason);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    await this.close();
  }

  private async say(text: string): Promise<void> {
    const controller = new AbortController();
    this.generation = controller;
    this.turn.agentStartedSpeaking();
    this.record.transcript.push({ speaker: "agent", text, at: Date.now() });
    this.history.push({ role: "assistant", content: text });
    await this.playback.play(
      this.deps.synthesiser.speak(text, controller.signal),
      controller.signal,
    );
    this.playback.flush();
    this.send(markMessage(this.deps.streamSid, "utterance-end"));
    if (this.generation === controller) this.generation = null;
  }

  private fail(err: Error): void {
    console.error(`[${this.deps.callSid}] session error:`, err.message);
    void this.close();
  }

  /** End the call and persist the record. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.generation?.abort();
    this.deps.recogniser.close();
    this.deps.synthesiser.close();

    this.record.endedAt = new Date().toISOString();
    this.record.collected = this.collected;
    if (this.record.outcome === "in_progress") this.record.outcome = "abandoned";

    try {
      await this.deps.persist(this.record);
    } catch (err) {
      // Losing the socket must not lose the job. This is the last line of
      // defence; the control plane also reconciles from Twilio's call log.
      console.error(`[${this.deps.callSid}] failed to persist call record:`, err);
    }
  }

  /** Snapshot, for tests and the live-call view in the dashboard. */
  get snapshot(): Readonly<CallRecord> {
    return { ...this.record, collected: { ...this.collected } };
  }
}

export { REQUIRED_KEYS };
