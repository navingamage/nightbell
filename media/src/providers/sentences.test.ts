import { describe, expect, it } from "vitest";
import { SentenceSplitter } from "./sentences.js";

/** Feed a whole string one character at a time, as a token stream would. */
function stream(text: string): { sentences: string[]; rest: string | null } {
  const splitter = new SentenceSplitter();
  const sentences: string[] = [];
  for (const ch of text) sentences.push(...splitter.push(ch));
  return { sentences, rest: splitter.flush() };
}

describe("SentenceSplitter", () => {
  it("emits a sentence as soon as it completes", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("Okay. ")).toEqual(["Okay."]);
  });

  it("holds an incomplete sentence back", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("I've got your")).toEqual([]);
  });

  it("splits several sentences in one delta", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("Got it. On my way. See you soon.")).toEqual([
      "Got it.",
      "On my way.",
    ]);
    expect(splitter.flush()).toBe("See you soon.");
  });

  it("handles questions and exclamations", () => {
    const { sentences } = stream("Is it still running? Okay! ");
    expect(sentences).toEqual(["Is it still running?", "Okay!"]);
  });

  it("returns the tail on flush", () => {
    const { rest } = stream("No trailing punctuation here");
    expect(rest).toBe("No trailing punctuation here");
  });

  it("returns null from flush when nothing is pending", () => {
    const splitter = new SentenceSplitter();
    splitter.push("Done. ");
    expect(splitter.flush()).toBeNull();
  });
});

describe("SentenceSplitter: things that must not be split", () => {
  it("does not break on a decimal", () => {
    // "about 3.5 inches" read as two sentences sounds broken.
    const { sentences, rest } = stream("There's about 3.5 inches of water");
    expect(sentences).toEqual([]);
    expect(rest).toBe("There's about 3.5 inches of water");
  });

  it("does not break on a street abbreviation", () => {
    const { sentences, rest } = stream("That's 400 W. Cesar Chavez");
    expect(sentences).toEqual([]);
    expect(rest).toBe("That's 400 W. Cesar Chavez");
  });

  it("does not break on an apartment abbreviation", () => {
    const { sentences } = stream("Apt. 12B, got it. ");
    expect(sentences).toEqual(["Apt. 12B, got it."]);
  });

  it("does not break on a title", () => {
    const { sentences } = stream("Thanks Dr. Reyes. ");
    expect(sentences).toEqual(["Thanks Dr. Reyes."]);
  });

  it("does not break mid-token when punctuation is not followed by a space", () => {
    const { sentences, rest } = stream("version 2.1.4");
    expect(sentences).toEqual([]);
    expect(rest).toBe("version 2.1.4");
  });
});

describe("SentenceSplitter: long clauses", () => {
  it("forces a break rather than waiting forever", () => {
    // A model that rambles without punctuation must not stall time-to-audio.
    const long = "so what I'm going to do is get someone out to you and they will bring the extraction equipment along with a dehumidifier and some air movers as well";
    const { sentences } = stream(long);
    expect(sentences.length).toBeGreaterThan(0);
  });

  it("prefers a comma when forced to break", () => {
    const long =
      "we will send a technician with extraction gear, and they should reach the property within about ninety minutes of right now depending on traffic conditions";
    const { sentences } = stream(long);
    expect(sentences[0]!.endsWith(",")).toBe(true);
  });

  it("loses no text across a forced break", () => {
    const long = "a".repeat(80) + " " + "b".repeat(80) + " " + "c".repeat(40);
    const { sentences, rest } = stream(long);
    const rebuilt = [...sentences, rest ?? ""].join(" ").replace(/\s+/g, " ").trim();
    expect(rebuilt).toBe(long);
  });
});
