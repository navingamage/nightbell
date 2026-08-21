/**
 * Turn-taking: deciding who is allowed to be talking, and when that changes.
 *
 * This is the part that makes a voice agent feel like a person or like a
 * kiosk, and almost none of it is model quality. Two humans hand the floor
 * back and forth with gaps averaging around 200 ms, and they overlap
 * constantly without either party treating it as an interruption. A system
 * that waits for a clean second of silence before answering feels slow even
 * when every individual component is fast, and a system that stops dead the
 * moment it hears a sound cannot be talked to at all: the caller says "mm-hm"
 * and the agent abandons its sentence.
 *
 * So this module holds a small explicit state machine with two separate
 * decisions in it:
 *
 *   - *Endpointing*, has the caller finished their turn? Tuned per question,
 *     because "is the water still running?" and "tell me what happened" want
 *     very different amounts of patience.
 *
 *   - *Barge-in*, is the caller trying to take the floor back? Deliberately
 *     harder to trigger than mere energy, because backchannels are not
 *     interruptions.
 *
 * Both are cheap, local, and deterministic. Nothing here asks a model what to
 * do, because a round trip to a model is exactly the latency being budgeted.
 */

import { FRAME_MS, frameEnergy } from "./audio.js";

export type TurnState =
  /** Nobody is speaking. Start of call, or a lull after the agent finished. */
  | "idle"
  /** The caller has the floor and we are accumulating their utterance. */
  | "listening"
  /** The caller finished; the model is working on a reply. */
  | "thinking"
  /** The agent has the floor and audio is streaming to the caller. */
  | "speaking";

/**
 * How long to wait for silence before deciding the caller has finished.
 *
 * These are the highest-leverage numbers in the whole system. Endpointing
 * dominates perceived latency, being dead air the caller sits through before
 * anything else has even started, so it is worth being aggressive where the
 * expected answer is short and patient where it is not.
 */
export type EndpointProfile =
  /** Yes/no, or a digit. Cut fast; the caller is done almost immediately. */
  | "terse"
  /** A name, an address, a phone number. Allow for mid-utterance thinking. */
  | "detail"
  /** "Tell me what happened." Let them talk; pausing is part of narrating. */
  | "open";

const SILENCE_MS: Record<EndpointProfile, number> = {
  terse: 380,
  detail: 700,
  // Someone describing a flooded basement pauses to look around. Cutting them
  // off at 700 ms makes the agent feel like it is not listening.
  open: 1100,
};

export interface TurnConfig {
  /** RMS amplitude (0..1) above which a frame counts as speech. */
  energyThreshold: number;
  /** Consecutive speech frames before we believe the caller started talking. */
  framesToOpen: number;
  /** Consecutive speech frames, while the agent talks, that count as barge-in. */
  framesToBargeIn: number;
  /** Starting endpoint profile before the agent has asked anything. */
  initialProfile: EndpointProfile;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  // Telephone lines carry a constant noise floor, and a restoration caller is
  // often standing next to a running extraction fan. This sits above typical
  // line noise without needing the caller to raise their voice.
  energyThreshold: 0.035,
  // 100 ms. Shorter than this and a door slam opens a turn.
  framesToOpen: 5,
  // 300 ms of sustained speech. A backchannel is typically under 250 ms, so
  // this alone filters most of them; the transcript check below catches the
  // rest.
  framesToBargeIn: 15,
  initialProfile: "detail",
};

/**
 * Words that do not take the floor.
 *
 * A caller saying "mm-hm" while the agent reads back an address is agreeing,
 * not interrupting. Treating that as barge-in produces the single most
 * irritating failure mode in voice agents: the agent that can never finish a
 * sentence. Matching is on the whole normalised utterance, so "okay" yields
 * nothing but "okay but wait" interrupts.
 */
const BACKCHANNELS = new Set([
  "mm", "mhm", "mm hm", "mmhm", "uh huh", "uhhuh", "huh",
  "yeah", "yep", "yes", "yup", "ok", "okay", "right", "sure",
  "got it", "gotcha", "i see", "alright", "all right", "correct",
]);

export function isBackchannel(text: string): boolean {
  const normalised = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalised.length > 0 && BACKCHANNELS.has(normalised);
}

export interface TurnEvents {
  /** The caller's turn ended. The accumulated transcript is ready to answer. */
  onCallerTurnEnd(utterance: string): void;
  /**
   * The caller took the floor back mid-sentence. Whoever is generating audio
   * must stop immediately and the already-buffered audio must be discarded.
   * On Twilio that means sending a `clear` message, because frames handed over
   * are queued on their side and will otherwise keep playing for seconds.
   */
  onBargeIn(): void;
  /** State transitions, for the call log and for latency instrumentation. */
  onStateChange?(from: TurnState, to: TurnState): void;
}

export class TurnController {
  private state: TurnState = "idle";
  private profile: EndpointProfile;
  private speechFrames = 0;
  private silenceFrames = 0;
  /** Finalised transcript pieces for the turn currently being accumulated. */
  private pending: string[] = [];
  /** Latest interim transcript, used only to suppress backchannel barge-in. */
  private interim = "";
  private sawSpeechThisTurn = false;

  constructor(
    private readonly events: TurnEvents,
    private readonly config: TurnConfig = DEFAULT_TURN_CONFIG,
  ) {
    this.profile = config.initialProfile;
  }

  get current(): TurnState {
    return this.state;
  }

  /**
   * Set how patient endpointing should be for the answer we are about to get.
   *
   * Called as the agent asks each question, since the agent knows what shape of
   * answer it expects. This is why the intake script in intake/schema.ts
   * carries a profile per field rather than leaving it to a global constant.
   */
  setEndpointProfile(profile: EndpointProfile): void {
    this.profile = profile;
  }

  private transition(to: TurnState): void {
    if (to === this.state) return;
    const from = this.state;
    this.state = to;
    this.events.onStateChange?.(from, to);
  }

  private get silenceFramesToClose(): number {
    return Math.round(SILENCE_MS[this.profile] / FRAME_MS);
  }

  /** Called when the agent begins streaming audio to the caller. */
  agentStartedSpeaking(): void {
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.transition("speaking");
  }

  /** Called when the agent's audio has finished playing out. */
  agentStoppedSpeaking(): void {
    if (this.state === "speaking") {
      this.speechFrames = 0;
      this.silenceFrames = 0;
      this.transition("idle");
    }
  }

  /** Called when the reply is being generated, before any audio exists. */
  agentThinking(): void {
    this.transition("thinking");
  }

  /**
   * Feed one 20 ms inbound frame from the caller.
   *
   * This runs fifty times a second per call and is the only thing on the hot
   * path, so it does energy arithmetic and integer counting and nothing else.
   */
  pushFrame(ulaw: Buffer): void {
    const isSpeech = frameEnergy(ulaw) >= this.config.energyThreshold;

    if (isSpeech) {
      this.speechFrames++;
      this.silenceFrames = 0;
    } else {
      this.silenceFrames++;
      this.speechFrames = 0;
    }

    switch (this.state) {
      case "idle":
      case "thinking": {
        // The caller starting to talk while we are still thinking is normal:
        // they are adding detail, not interrupting, since no audio is playing.
        if (this.speechFrames >= this.config.framesToOpen) {
          this.sawSpeechThisTurn = true;
          this.transition("listening");
        }
        break;
      }

      case "listening": {
        if (isSpeech) this.sawSpeechThisTurn = true;
        if (this.sawSpeechThisTurn && this.silenceFrames >= this.silenceFramesToClose) {
          this.closeTurn();
        }
        break;
      }

      case "speaking": {
        // Energy alone is not enough. It has to be sustained, and it must not
        // be a backchannel. See the note on BACKCHANNELS.
        if (this.speechFrames >= this.config.framesToBargeIn && !isBackchannel(this.interim)) {
          this.sawSpeechThisTurn = true;
          this.events.onBargeIn();
          this.transition("listening");
        }
        break;
      }
    }
  }

  /**
   * Feed a transcript from the speech recogniser.
   *
   * Interim results are kept only so barge-in can check them against the
   * backchannel list. Final results accumulate into the turn, because one
   * caller turn frequently arrives as several finals ("it's the basement" /
   * "the water heater burst").
   */
  pushTranscript(text: string, isFinal: boolean): void {
    if (!text.trim()) return;

    if (isFinal) {
      this.pending.push(text.trim());
      this.interim = "";
      this.sawSpeechThisTurn = true;
      // A final transcript arriving while the agent talks is the strongest
      // possible barge-in signal, because the recogniser is confident enough to
      // commit to words, but a bare "okay" still must not stop the agent.
      if (this.state === "speaking" && !isBackchannel(text)) {
        this.events.onBargeIn();
        this.transition("listening");
      }
    } else {
      this.interim = text;
    }
  }

  /**
   * Force the current turn closed.
   *
   * Used when the recogniser reports its own endpoint, which is usually better
   * informed than raw energy because it has an acoustic model behind it. Energy
   * endpointing stays as the backstop for when the recogniser goes quiet.
   */
  closeTurn(): void {
    const utterance = this.pending.join(" ").trim();
    this.pending = [];
    this.interim = "";
    this.silenceFrames = 0;
    this.speechFrames = 0;
    this.sawSpeechThisTurn = false;

    if (!utterance) {
      // Energy without words. Someone coughed, or the line popped. Do not wake
      // the model up for it.
      this.transition("idle");
      return;
    }

    this.transition("thinking");
    this.events.onCallerTurnEnd(utterance);
  }

  /** Discard partial state, e.g. after a transfer or a hangup. */
  reset(): void {
    this.pending = [];
    this.interim = "";
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.sawSpeechThisTurn = false;
    this.transition("idle");
  }
}
