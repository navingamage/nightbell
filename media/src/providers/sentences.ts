/**
 * Splitting a token stream into speakable units.
 *
 * The model emits tokens; the synthesiser wants sentences. Getting the boundary
 * wrong in either direction costs something real:
 *
 *   - Too eager, and the synthesiser is handed "Okay, I've got 512 555" and
 *     reads it with a falling, finished intonation before the rest arrives.
 *     Phone numbers and addresses are where this is most obvious and most
 *     damaging, since those are exactly the strings a caller is checking.
 *
 *   - Too patient, and time-to-first-audio becomes time-to-whole-response,
 *     which throws away the entire benefit of streaming.
 *
 * The compromise here is to flush on sentence-final punctuation, but only when
 * the punctuation is not part of an abbreviation, a decimal, or a number
 * grouping — and to force a flush once a clause gets long enough that waiting
 * is worse than an imperfect break.
 */

/** Beyond this many characters, flush at the next comma or space regardless. */
const MAX_CLAUSE_CHARS = 140;

/**
 * Abbreviations whose trailing period does not end a sentence. Address-heavy
 * by design — this is a restoration intake, so streets, avenues, apartment
 * numbers and compass points dominate the read-backs.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "st", "ave", "blvd", "rd", "ln", "ct", "dept",
  "apt", "ste", "no", "approx", "e", "w", "n", "s", "ne", "nw", "se", "sw",
]);

function endsWithAbbreviation(buffer: string): boolean {
  const match = /(\w+)\.$/.exec(buffer.trimEnd());
  if (!match) return false;
  return ABBREVIATIONS.has(match[1]!.toLowerCase());
}

/**
 * Find the index just past a sentence-final punctuation mark, or -1.
 *
 * A mark only counts as a break when the *following* character is whitespace.
 * That rule does all the work: it keeps "3.5" and "2.1.4" intact without any
 * special-casing for decimals, because the character after those periods is a
 * digit rather than a space.
 *
 * The subtle part is the buffer-final case. When a period is the last thing in
 * the buffer there is genuinely not enough information yet — "about 3." and
 * "about 3.5" are identical prefixes, and committing to a break produces the
 * synthesiser reading "there's about three" with finished intonation before
 * the "point five" shows up. So a trailing mark is never a break during push();
 * flush() deals with the case where it really was the end.
 */
function findBreak(buffer: string): number {
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i]!;
    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    const next = buffer[i + 1];
    if (next === undefined) continue; // undecidable until more text arrives
    if (!/\s/.test(next)) continue;
    if (ch === "." && endsWithAbbreviation(buffer.slice(0, i + 1))) continue;

    return i + 1;
  }
  return -1;
}

/**
 * Fallback break for an over-long clause: the last comma, else the last space.
 *
 * A comma is a real prosodic boundary and a space is not, so a comma is worth
 * preferring even when it leaves a shorter chunk. The floor only exists to stop
 * a comma in the first few words producing a two-word fragment.
 */
const MIN_SOFT_BREAK_CHARS = 20;

function findSoftBreak(buffer: string): number {
  const comma = buffer.lastIndexOf(", ");
  if (comma >= MIN_SOFT_BREAK_CHARS) return comma + 1;
  const space = buffer.lastIndexOf(" ");
  return space > 0 ? space : -1;
}

/**
 * Incremental splitter. Feed it token deltas; it yields speakable sentences.
 *
 * Stateful rather than functional because it sits in the middle of a stream and
 * has to remember the partial sentence between calls.
 */
export class SentenceSplitter {
  private buffer = "";

  /** Push a token delta, returning any sentences that are now complete. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];

    for (;;) {
      let cut = findBreak(this.buffer);
      if (cut === -1 && this.buffer.length >= MAX_CLAUSE_CHARS) {
        cut = findSoftBreak(this.buffer);
      }
      if (cut === -1) break;

      const sentence = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (sentence) out.push(sentence);
    }

    return out;
  }

  /** Return whatever is left. Call once the model has finished generating. */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest || null;
  }
}
