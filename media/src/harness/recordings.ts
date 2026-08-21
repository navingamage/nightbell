/**
 * Calls that already happened, replayed as tests.
 *
 * The six written scenarios cover the calls we thought of. Real callers do not
 * confine themselves to those: they ask for a plumber, they answer a question
 * that was not asked, they say "hello?" into a silence, they give an address
 * three sentences before it is wanted. Every one of those is a call the agent
 * either handled or did not, and once it is written down it is a test.
 *
 * So a recording is just a scenario with provenance. Nothing here knows how to
 * run one, because `run.ts` already does: the whole point of the shape is that a
 * call taken this afternoon and a scenario written by hand are the same object
 * by the time the harness sees them.
 *
 * The workflow this exists for:
 *
 *   1. Something goes wrong on a call, in `npm run call` or on a real line.
 *   2. Save it. The expectations are seeded from what the call actually did.
 *   3. Edit `expect` to say what it *should* have done, if it did the wrong
 *      thing. That file now fails.
 *   4. Fix the code. It passes, and it keeps passing.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallRecord } from "../call/session.js";
import type { Scenario } from "./scenarios.js";

/** Resolved from this file rather than the cwd, so it works from anywhere. */
export const RECORDINGS_DIR = fileURLToPath(new URL("../../recordings", import.meta.url));

export interface Recording extends Scenario {
  /** ISO timestamp of the call this came from. */
  recordedAt: string;
  /** The model that was answering, when there was one. */
  model?: string;
  /** Where it came from: an interactive session, or a real call by its sid. */
  source: string;
}

/**
 * Every recording on disk, oldest first.
 *
 * A malformed file is a hard error rather than a skip. A regression test that
 * quietly stops running is worse than one that was never written, because the
 * suite still reports green and nobody looks again.
 */
export async function loadRecordings(): Promise<Recording[]> {
  let names: string[];
  try {
    names = await readdir(RECORDINGS_DIR);
  } catch {
    return [];
  }

  const out: Recording[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const path = join(RECORDINGS_DIR, name);
    const raw = await readFile(path, "utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${name}: not valid JSON (${(err as Error).message})`);
    }

    out.push(validate(parsed, name));
  }
  return out;
}

function validate(value: unknown, name: string): Recording {
  const r = value as Partial<Recording>;
  const problems: string[] = [];

  if (!r.id) problems.push("missing id");
  if (!Array.isArray(r.utterances) || r.utterances.length === 0) {
    problems.push("no utterances");
  }
  if (!r.expect?.urgency) problems.push("missing expect.urgency");
  if (!r.expect?.outcome) problems.push("missing expect.outcome");

  if (problems.length > 0) {
    throw new Error(`${name}: ${problems.join(", ")}`);
  }
  return r as Recording;
}

/**
 * Turn a finished call into a scenario, seeded with what it actually did.
 *
 * Seeded, not asserted. If the call went wrong, the file now encodes the wrong
 * behaviour, and the person saving it is expected to edit `expect` to say what
 * should have happened. That edit is the bug report, and it is executable.
 */
export function fromCallRecord(
  record: Pick<CallRecord, "transcript" | "triage" | "outcome" | "startedAt" | "callSid">,
  meta: { id: string; title: string; note: string; model?: string; source?: string },
): Recording {
  return {
    id: meta.id,
    title: meta.title,
    note: meta.note,
    recordedAt: record.startedAt,
    ...(meta.model ? { model: meta.model } : {}),
    source: meta.source ?? record.callSid,
    utterances: record.transcript.filter((t) => t.speaker === "caller").map((t) => t.text),
    expect: {
      urgency: record.triage.urgency,
      outcome: record.outcome,
      rules: [...new Set(record.triage.hits.map((h) => h.ruleId))],
    },
  };
}

/** Write a recording, and return the path it landed at. */
export async function saveRecording(recording: Recording): Promise<string> {
  await mkdir(RECORDINGS_DIR, { recursive: true });
  const path = join(RECORDINGS_DIR, `${recording.id}.json`);
  await writeFile(path, `${JSON.stringify(recording, null, 2)}\n`, "utf8");
  return path;
}
