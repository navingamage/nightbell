/**
 * Session tests, against fake providers.
 *
 * These exercise the two guarantees the orchestrator exists to provide — that a
 * caller can always interrupt, and that the model cannot talk the system out of
 * an escalation — plus the ordering detail that makes barge-in actually work.
 * Everything is faked, so the suite runs in milliseconds and needs no keys.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { type CallRecord, Session, type TenantConfig } from "./session.js";
import { encode } from "./audio.js";

const TENANT: TenantConfig = {
  tenantId: "t_test",
  businessName: "Test Restoration",
  serviceArea: "Austin",
  timezone: "America/Chicago",
  onCallNumber: "+15125550000",
  greeting: "Test Restoration, this is the after-hours line.",
};

class FakeRecogniser implements SpeechRecogniser {
  handler: ((t: Transcript) => void) | null = null;
  closed = false;
  write(): void {}
  async finish(): Promise<void> {}
  close(): void {
    this.closed = true;
  }
  onTranscript(h: (t: Transcript) => void): void {
    this.handler = h;
  }
  onError(): void {}
  /** Simulate the recogniser producing a final transcript. */
  emit(text: string): void {
    this.handler?.({ text, isFinal: true, speechFinal: true });
  }
}

class FakeSynthesiser implements SpeechSynthesiser {
  spoken: string[] = [];
  closed = false;
  /** Set to stall synthesis so a barge-in can land mid-utterance. */
  gate: Promise<void> | null = null;

  async *speak(text: string, signal: AbortSignal): AsyncIterable<Buffer> {
    this.spoken.push(text);
    if (this.gate) await this.gate;
    if (signal.aborted) return;
    yield encode(new Int16Array(160));
  }
  close(): void {
    this.closed = true;
  }
}

class FakeModel implements LanguageModel {
  /** Queued replies, each a list of sentences plus optional tool calls. */
  queue: Array<{ sentences: string[]; tools?: ToolCall[] }> = [];
  prompts: string[] = [];
  /** Per-turn state, which the session sends alongside the system prompt. */
  contexts: string[] = [];
  lastTools: ToolDefinition[] = [];
  lastHistory: ConversationTurn[] = [];

  respond(params: {
    system: string;
    context?: string;
    history: ConversationTurn[];
    tools: ToolDefinition[];
    signal: AbortSignal;
  }): ModelResponse {
    this.prompts.push(params.system);
    this.contexts.push(params.context ?? "");
    this.lastTools = params.tools;
    this.lastHistory = [...params.history];
    const next = this.queue.shift() ?? { sentences: ["Okay."] };

    const sentences = (async function* () {
      for (const s of next.sentences) {
        if (params.signal.aborted) return;
        yield s;
      }
    })();

    return { sentences, toolCalls: Promise.resolve(next.tools ?? []) };
  }
}

function makeSocket() {
  const sent: string[] = [];
  return {
    sent,
    OPEN: 1 as const,
    readyState: 1 as const,
    send: (msg: string) => sent.push(msg),
    close: () => {},
  };
}

function setup() {
  const socket = makeSocket();
  const recogniser = new FakeRecogniser();
  const synthesiser = new FakeSynthesiser();
  const model = new FakeModel();
  // Typed explicitly so the argument tuples are inferred — an untyped vi.fn()
  // infers `[]` and every mock.calls[n][m] read becomes a type error.
  const persist = vi.fn(async (_record: CallRecord): Promise<void> => {});
  const transfer = vi.fn(
    async (_callSid: string, _to: string, _reason: string): Promise<void> => {},
  );

  const session = new Session({
    socket: socket as unknown as import("ws").WebSocket,
    streamSid: "MZ_test",
    callSid: "CA_test",
    tenant: TENANT,
    recogniser,
    synthesiser,
    model,
    persist,
    transfer,
  });

  return { session, socket, recogniser, synthesiser, model, persist, transfer };
}

/** Loud frames, enough to open a turn. */
function speak(session: Session, frames = 10): void {
  const frame = encode(new Int16Array(160).fill(12000));
  for (let i = 0; i < frames; i++) session.onAudio(frame);
}

describe("Session: greeting", () => {
  it("speaks the tenant greeting on start", async () => {
    const { session, synthesiser } = setup();
    await session.start();
    expect(synthesiser.spoken[0]).toBe(TENANT.greeting);
  });

  it("sends audio to the carrier", async () => {
    const { session, socket } = setup();
    await session.start();
    expect(socket.sent.some((m) => m.includes('"event":"media"'))).toBe(true);
  });

  it("marks the end of the greeting so playback completion is observable", async () => {
    const { session, socket } = setup();
    await session.start();
    expect(socket.sent.some((m) => m.includes("utterance-end"))).toBe(true);
  });
});

describe("Session: triage authority", () => {
  it("transfers on a hard hazard without consulting the model", async () => {
    const { session, recogniser, model, transfer } = setup();
    await session.start();
    model.prompts.length = 0;

    speak(session);
    recogniser.emit("I think I smell gas down here");
    await vi.waitFor(() => expect(transfer).toHaveBeenCalled());

    // The model was never asked. Safety escalation does not go through it.
    expect(model.prompts).toHaveLength(0);
    expect(transfer.mock.calls[0]?.[1]).toBe(TENANT.onCallNumber);
  });

  it("tells the model an escalation is settled fact", async () => {
    const { session, recogniser, model } = setup();
    await session.start();

    speak(session);
    recogniser.emit("the sewer backed up into the basement");
    await vi.waitFor(() => expect(model.prompts.length).toBeGreaterThan(0));

    // The escalation rides in the per-turn context rather than the system
    // prompt, so that the system prompt stays byte-identical across turns and
    // can be cached. What the model is told is unchanged.
    const context = model.contexts.at(-1)!;
    expect(context).toContain("dispatch_now");
    expect(context).toMatch(/settled fact/i);
  });

  it("keeps the system prompt identical across turns, so it can be cached", async () => {
    const { session, recogniser, model } = setup();
    await session.start();

    speak(session);
    recogniser.emit("the sewer backed up into the basement");
    await vi.waitFor(() => expect(model.prompts.length).toBeGreaterThan(0));

    speak(session);
    recogniser.emit("it's twelve twenty one maple street");
    await vi.waitFor(() => expect(model.prompts.length).toBeGreaterThan(1));

    // Prompt caching matches on an exact prefix. A clock reading or a running
    // "still needed" list in here would mean no two turns ever share one, and
    // the cache would silently become a surcharge rather than a saving.
    expect(new Set(model.prompts).size).toBe(1);

    // And the state that does move between turns stays out of the cached half.
    expect(model.prompts.at(-1)).not.toContain("dispatch_now");
    expect(model.contexts.at(-1)).toContain("dispatch_now");
  });

  it("does not let the model's opinion lower the rules' verdict", async () => {
    const { session, recogniser, model } = setup();
    await session.start();
    model.queue.push({
      sentences: ["Okay."],
      tools: [
        {
          id: "tu_1",
          name: "record_details",
          input: { situation: "some water", urgency_opinion: "routine" },
        },
      ],
    });
    model.queue.push({ sentences: ["Got it."] });

    speak(session);
    recogniser.emit("the sewer backed up into the basement");
    await vi.waitFor(() => expect(session.snapshot.triage.urgency).toBe("dispatch_now"));
  });

  it("keeps an escalation from earlier in the call", async () => {
    const { session, recogniser } = setup();
    await session.start();

    speak(session);
    recogniser.emit("the sewer backed up");
    await vi.waitFor(() => expect(session.snapshot.triage.urgency).toBe("dispatch_now"));

    // A later, mundane utterance must not decay the earlier escalation.
    speak(session);
    recogniser.emit("anyway the address is 400 west street");
    await vi.waitFor(() => expect(session.snapshot.triage.urgency).toBe("dispatch_now"));
  });
});

describe("Session: barge-in", () => {
  it("clears the carrier queue when the caller interrupts", async () => {
    const { session, socket, synthesiser, model, recogniser } = setup();
    await session.start();

    // Stall synthesis so the caller can interrupt mid-utterance.
    let release!: () => void;
    synthesiser.gate = new Promise<void>((r) => {
      release = r;
    });
    model.queue.push({ sentences: ["This is a long reply.", "With a second sentence."] });

    speak(session);
    recogniser.emit("there is water in the basement");
    await vi.waitFor(() => expect(synthesiser.spoken.length).toBeGreaterThan(1));

    socket.sent.length = 0;
    recogniser.emit("no wait, it's the upstairs bathroom");

    // The clear is what actually stops audio the carrier already holds.
    expect(socket.sent.some((m) => m.includes('"event":"clear"'))).toBe(true);
    release();
  });

  it("does not clear on a backchannel", async () => {
    const { session, socket, synthesiser, model, recogniser } = setup();
    await session.start();

    let release!: () => void;
    synthesiser.gate = new Promise<void>((r) => {
      release = r;
    });
    model.queue.push({ sentences: ["Reading that back to you now.", "Four hundred west."] });

    speak(session);
    recogniser.emit("there is water in the basement");
    await vi.waitFor(() => expect(synthesiser.spoken.length).toBeGreaterThan(1));

    socket.sent.length = 0;
    recogniser.emit("mm-hm");

    expect(socket.sent.some((m) => m.includes('"event":"clear"'))).toBe(false);
    release();
  });
});

describe("Session: mark handling", () => {
  it("stops treating the agent as speaking once the mark comes back", async () => {
    // Twilio's mark event is the only signal that audio actually finished
    // playing. If it never arrives, the turn controller believes the agent is
    // still talking forever and classifies every later caller turn as a
    // barge-in — which aborts generation and silently discards the tool calls
    // that turn produced, so the intake collects nothing. Found by the offline
    // harness, which originally swallowed marks the way an inert fake does.
    const { session, recogniser, model, socket } = setup();
    await session.start();

    const mark = socket.sent.find((m) => m.includes("utterance-end"));
    expect(mark).toBeDefined();
    session.onMark("utterance-end");

    model.queue.push({
      sentences: ["Got it."],
      tools: [
        { id: "tu_1", name: "record_details", input: { caller_name: "Dana Whitfield" } },
      ],
    });
    model.queue.push({ sentences: ["And the address?"] });

    speak(session);
    recogniser.emit("Dana Whitfield");

    await vi.waitFor(() =>
      expect(session.snapshot.collected["caller_name"]).toBe("Dana Whitfield"),
    );
  });
});

describe("Session: booking", () => {
  it("refuses to book before the required fields are collected", async () => {
    const { session, recogniser, model } = setup();
    await session.start();
    model.queue.push({
      sentences: ["Booking that now."],
      tools: [
        {
          id: "tu_1",
          name: "book_job",
          input: { confirmed_address: "400 W St", confirmed_callback: "5125551234" },
        },
      ],
    });
    model.queue.push({ sentences: ["Actually I still need a few things."] });

    speak(session);
    recogniser.emit("can you just send someone");
    await vi.waitFor(() => expect(model.prompts.length).toBeGreaterThan(1));

    expect(session.snapshot.outcome).toBe("in_progress");
    // The model is told what is missing rather than silently ignored.
    const result = model.lastHistory.find((t) => t.role === "tool_result");
    expect(result && "content" in result ? result.content : "").toContain("still_needed");
  });
});

describe("Session: tool rounds", () => {
  it("stops re-prompting the model once the round cap is reached", async () => {
    // A model that answers every tool result with another tool call has no
    // terminating condition, and every lap speaks. On a live run against a cheap
    // model this ran for forty-eight seconds inside one caller turn, asking the
    // same question over and over. The cap ends the turn instead.
    const { session, recogniser, model, synthesiser } = setup();
    await session.start();
    session.onMark("utterance-end");

    for (let i = 0; i < 10; i++) {
      model.queue.push({
        sentences: ["What's the address?"],
        tools: [{ id: `tu_${i}`, name: "record_details", input: { situation: "flood" } }],
      });
    }

    speak(session);
    recogniser.emit("my basement is flooded");

    await vi.waitFor(() => expect(model.prompts.length).toBeGreaterThan(1));
    // Let any further round it was going to run actually run.
    await new Promise((r) => setTimeout(r, 50));

    // The greeting, plus at most one utterance per round.
    expect(synthesiser.spoken.length).toBeLessThanOrEqual(4);
    expect(model.queue.length).toBeGreaterThan(5);
  });
});

describe("Session: teardown", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("persists the call record on close", async () => {
    await ctx.session.start();
    await ctx.session.close();
    expect(ctx.persist).toHaveBeenCalledOnce();
    expect(ctx.persist.mock.calls[0]?.[0]).toMatchObject({ callSid: "CA_test" });
  });

  it("marks an unfinished call as abandoned", async () => {
    await ctx.session.start();
    await ctx.session.close();
    expect(ctx.persist.mock.calls[0]?.[0]).toMatchObject({ outcome: "abandoned" });
  });

  it("closes both provider sockets", async () => {
    await ctx.session.start();
    await ctx.session.close();
    expect(ctx.recogniser.closed).toBe(true);
    expect(ctx.synthesiser.closed).toBe(true);
  });

  it("is idempotent", async () => {
    await ctx.session.start();
    await ctx.session.close();
    await ctx.session.close();
    expect(ctx.persist).toHaveBeenCalledOnce();
  });

  it("still closes when persistence fails", async () => {
    ctx.persist.mockRejectedValueOnce(new Error("control plane down"));
    await ctx.session.start();
    await expect(ctx.session.close()).resolves.toBeUndefined();
  });
});
