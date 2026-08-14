/**
 * Paced playback of agent audio to the carrier.
 *
 * Twilio accepts frames as fast as you send them and queues whatever it gets.
 * Dumping a whole synthesised sentence at once therefore "works", right up
 * until the caller interrupts — at which point several seconds of audio are
 * already committed and a `clear` produces an abrupt mid-word cut rather than a
 * natural stop.
 *
 * So audio is paced out at roughly realtime with a small lead. The lead absorbs
 * jitter in synthesis and event-loop scheduling; keeping it small bounds how
 * much audio can be in flight when a barge-in lands, which is what makes
 * interruption sound like a person stopping rather than a recording being
 * switched off.
 */

import { FRAME_MS, chunkFrames } from "./audio.js";

/**
 * How far ahead of realtime to run, in milliseconds.
 *
 * Too small and any scheduling hiccup produces an audible gap. Too large and
 * interruptions feel laggy. 200 ms is about ten frames — comfortably more than
 * the event loop's worst case here, and short enough that a barge-in cuts off
 * within a syllable.
 */
const LEAD_MS = 200;

export interface PlaybackSink {
  sendFrame(frame: Buffer): void;
  /** Ask the carrier to discard everything queued. */
  clear(): void;
}

export class Playback {
  private remainder = Buffer.alloc(0);
  /** Playout position in ms, relative to the clock, for pacing. */
  private playheadMs = 0;
  private active = false;

  constructor(
    private readonly sink: PlaybackSink,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get isPlaying(): boolean {
    return this.active;
  }

  /**
   * Stream one synthesised utterance to the caller.
   *
   * Returns when the audio has been handed over — not when it has finished
   * playing. The `mark` round trip in session.ts is what reports true
   * completion.
   */
  async play(audio: AsyncIterable<Buffer>, signal: AbortSignal): Promise<void> {
    this.active = true;
    this.playheadMs = this.now();

    try {
      for await (const chunk of audio) {
        if (signal.aborted) return;

        const { frames, remainder } = chunkFrames(Buffer.concat([this.remainder, chunk]));
        this.remainder = Buffer.from(remainder);

        for (const frame of frames) {
          if (signal.aborted) return;

          const lead = this.playheadMs - this.now();
          if (lead > LEAD_MS) {
            await sleep(lead - LEAD_MS, signal);
            if (signal.aborted) return;
          }

          this.sink.sendFrame(frame);
          this.playheadMs += FRAME_MS;
        }
      }
    } finally {
      this.active = false;
    }
  }

  /**
   * Stop immediately and discard queued audio.
   *
   * Both halves are required. Aborting the signal stops us sending; the clear
   * discards what the carrier already holds. Doing only the first is the most
   * common barge-in bug there is.
   */
  stop(): void {
    this.remainder = Buffer.alloc(0);
    this.active = false;
    this.sink.clear();
  }

  /** Flush any sub-frame tail, padded to a whole frame. */
  flush(): void {
    if (this.remainder.length === 0) return;
    const padded = Buffer.alloc(160, 0xff); // μ-law silence
    this.remainder.copy(padded);
    this.sink.sendFrame(padded);
    this.remainder = Buffer.alloc(0);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(onDone, ms);
    function onDone(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onDone);
      resolve();
    }
    signal.addEventListener("abort", onDone, { once: true });
  });
}
