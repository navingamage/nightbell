import { beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "./audio.js";
import {
  DEFAULT_TURN_CONFIG,
  TurnController,
  type TurnEvents,
  isBackchannel,
} from "./turn.js";

/** A 20 ms frame loud enough to clear the speech threshold. */
const speech = () => encode(new Int16Array(160).fill(12000));
/** A 20 ms frame of near-silence, below the threshold. */
const silence = () => encode(new Int16Array(160).fill(0));

function feed(tc: TurnController, frame: () => Buffer, count: number): void {
  for (let i = 0; i < count; i++) tc.pushFrame(frame());
}

describe("isBackchannel", () => {
  it("recognises common acknowledgements", () => {
    for (const word of ["mm-hm", "yeah", "OK", "okay", "right", "got it", "uh huh"]) {
      expect(isBackchannel(word)).toBe(true);
    }
  });

  it("ignores punctuation and casing", () => {
    expect(isBackchannel("  Yeah!  ")).toBe(true);
    expect(isBackchannel("Uh-huh.")).toBe(true);
  });

  it("does not swallow real content that starts with an acknowledgement", () => {
    expect(isBackchannel("okay but the water is still running")).toBe(false);
    expect(isBackchannel("yeah it's the basement")).toBe(false);
  });

  it("treats empty input as not a backchannel", () => {
    expect(isBackchannel("")).toBe(false);
    expect(isBackchannel("   ")).toBe(false);
  });
});

describe("TurnController", () => {
  let events: TurnEvents & {
    onCallerTurnEnd: ReturnType<typeof vi.fn>;
    onBargeIn: ReturnType<typeof vi.fn>;
  };
  let tc: TurnController;

  beforeEach(() => {
    events = {
      onCallerTurnEnd: vi.fn(),
      onBargeIn: vi.fn(),
      onStateChange: vi.fn(),
    };
    tc = new TurnController(events);
  });

  it("starts idle", () => {
    expect(tc.current).toBe("idle");
  });

  it("opens a turn only after sustained speech", () => {
    feed(tc, speech, DEFAULT_TURN_CONFIG.framesToOpen - 1);
    expect(tc.current).toBe("idle");
    feed(tc, speech, 1);
    expect(tc.current).toBe("listening");
  });

  it("ignores an isolated transient", () => {
    // A door slam: two loud frames, then nothing.
    feed(tc, speech, 2);
    feed(tc, silence, 10);
    expect(tc.current).toBe("idle");
    expect(events.onCallerTurnEnd).not.toHaveBeenCalled();
  });

  it("ends the turn after enough silence and reports the transcript", () => {
    feed(tc, speech, 10);
    tc.pushTranscript("the basement is flooding", true);
    feed(tc, silence, 40); // 800 ms, past the 700 ms "detail" default
    expect(events.onCallerTurnEnd).toHaveBeenCalledWith("the basement is flooding");
    expect(tc.current).toBe("thinking");
  });

  it("joins several finals into one turn", () => {
    feed(tc, speech, 10);
    tc.pushTranscript("it's the basement", true);
    tc.pushTranscript("the water heater burst", true);
    feed(tc, silence, 40);
    expect(events.onCallerTurnEnd).toHaveBeenCalledWith(
      "it's the basement the water heater burst",
    );
  });

  it("does not wake the model for energy with no words", () => {
    // Caller coughs. Energy opens a turn, but no transcript ever arrives.
    feed(tc, speech, 10);
    feed(tc, silence, 40);
    expect(events.onCallerTurnEnd).not.toHaveBeenCalled();
    expect(tc.current).toBe("idle");
  });

  describe("endpoint profiles", () => {
    it("cuts faster on terse than on open", () => {
      tc.setEndpointProfile("terse");
      feed(tc, speech, 10);
      tc.pushTranscript("yes", true);
      feed(tc, silence, 20); // 400 ms, past terse's 380 ms
      expect(events.onCallerTurnEnd).toHaveBeenCalledOnce();
    });

    it("stays patient through a mid-sentence pause on open", () => {
      tc.setEndpointProfile("open");
      feed(tc, speech, 10);
      tc.pushTranscript("so I came downstairs and", true);
      feed(tc, silence, 40); // 800 ms, a pause, not an ending
      expect(events.onCallerTurnEnd).not.toHaveBeenCalled();

      feed(tc, speech, 10);
      tc.pushTranscript("there was water everywhere", true);
      feed(tc,
        silence, 60); // 1200 ms, past open's 1100 ms
      expect(events.onCallerTurnEnd).toHaveBeenCalledWith(
        "so I came downstairs and there was water everywhere",
      );
    });
  });

  describe("barge-in", () => {
    beforeEach(() => {
      tc.agentStartedSpeaking();
      expect(tc.current).toBe("speaking");
    });

    it("fires on sustained speech over the agent", () => {
      feed(tc, speech, DEFAULT_TURN_CONFIG.framesToBargeIn);
      expect(events.onBargeIn).toHaveBeenCalledOnce();
      expect(tc.current).toBe("listening");
    });

    it("does not fire on a short burst", () => {
      feed(tc, speech, DEFAULT_TURN_CONFIG.framesToBargeIn - 1);
      expect(events.onBargeIn).not.toHaveBeenCalled();
      expect(tc.current).toBe("speaking");
    });

    it("does not fire when the caller is only acknowledging", () => {
      // "mm-hm" over the top of the agent reading back an address.
      tc.pushTranscript("mm-hm", false);
      feed(tc, speech, DEFAULT_TURN_CONFIG.framesToBargeIn + 5);
      expect(events.onBargeIn).not.toHaveBeenCalled();
      expect(tc.current).toBe("speaking");
    });

    it("fires immediately on a final transcript with real content", () => {
      tc.pushTranscript("no wait it's the upstairs bathroom", true);
      expect(events.onBargeIn).toHaveBeenCalledOnce();
      expect(tc.current).toBe("listening");
    });

    it("does not fire on a final transcript that is just an acknowledgement", () => {
      tc.pushTranscript("okay", true);
      expect(events.onBargeIn).not.toHaveBeenCalled();
      expect(tc.current).toBe("speaking");
    });
  });

  describe("speaking while thinking", () => {
    it("treats added detail during thinking as a new turn, not a barge-in", () => {
      feed(tc, speech, 10);
      tc.pushTranscript("the basement is flooding", true);
      feed(tc, silence, 40);
      expect(tc.current).toBe("thinking");

      feed(tc, speech, 10);
      expect(events.onBargeIn).not.toHaveBeenCalled();
      expect(tc.current).toBe("listening");
    });
  });

  it("resets cleanly", () => {
    feed(tc, speech, 10);
    tc.pushTranscript("half a sentence", true);
    tc.reset();
    expect(tc.current).toBe("idle");

    feed(tc, speech, 10);
    tc.pushTranscript("a fresh start", true);
    feed(tc, silence, 40);
    expect(events.onCallerTurnEnd).toHaveBeenCalledWith("a fresh start");
  });
});
