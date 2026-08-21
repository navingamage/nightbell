import { describe, expect, it } from "vitest";
import {
  INTAKE_FIELDS,
  isBookable,
  missingRequired,
  nextField,
  normalisePhone,
  speakPhone,
} from "./schema.js";

/** A collected map with every required field filled in. */
function complete(): Record<string, unknown> {
  const collected: Record<string, unknown> = {};
  for (const field of INTAKE_FIELDS) {
    if (field.required) collected[field.key] = "answered";
  }
  return collected;
}

describe("intake script", () => {
  it("asks for the callback number first", () => {
    // A restoration call that drops without a number to ring back is a lost job.
    expect(nextField({})?.key).toBe("callback_number");
  });

  it("walks the fields in order", () => {
    const collected: Record<string, unknown> = {};
    const asked: string[] = [];
    let field = nextField(collected);
    while (field) {
      asked.push(field.key);
      collected[field.key] = "answered";
      field = nextField(collected);
    }
    expect(asked[0]).toBe("callback_number");
    expect(asked).toContain("property_address");
    expect(asked).toContain("water_still_active");
  });

  it("returns null once everything is collected", () => {
    const collected: Record<string, unknown> = {};
    for (const field of INTAKE_FIELDS) collected[field.key] = "answered";
    expect(nextField(collected)).toBeNull();
  });

  it("skips the claim number when there is no carrier", () => {
    const collected: Record<string, unknown> = {};
    for (const field of INTAKE_FIELDS) {
      if (field.key !== "claim_number" && field.key !== "insurance_carrier") {
        collected[field.key] = "answered";
      }
    }
    // Carrier is unanswered, so carrier is next, not the claim number.
    expect(nextField(collected)?.key).toBe("insurance_carrier");

    collected["insurance_carrier"] = "";
    expect(nextField(collected)?.key).not.toBe("claim_number");
  });

  it("asks for the claim number once a carrier is known", () => {
    const collected: Record<string, unknown> = {};
    for (const field of INTAKE_FIELDS) {
      if (field.key !== "claim_number") collected[field.key] = "answered";
    }
    collected["insurance_carrier"] = "State Farm";
    expect(nextField(collected)?.key).toBe("claim_number");
  });

  it("gives the open-ended question the most patient endpointing", () => {
    const situation = INTAKE_FIELDS.find((f) => f.key === "situation");
    expect(situation?.endpoint).toBe("open");
  });

  it("gives yes/no questions the fastest endpointing", () => {
    const stillActive = INTAKE_FIELDS.find((f) => f.key === "water_still_active");
    expect(stillActive?.endpoint).toBe("terse");
  });
});

describe("bookability", () => {
  it("is not bookable when empty", () => {
    expect(isBookable({})).toBe(false);
    expect(missingRequired({}).length).toBeGreaterThan(0);
  });

  it("is bookable once every required field is filled", () => {
    expect(isBookable(complete())).toBe(true);
    expect(missingRequired(complete())).toEqual([]);
  });

  it("treats an empty string as missing", () => {
    const collected = complete();
    collected["property_address"] = "";
    expect(isBookable(collected)).toBe(false);
    expect(missingRequired(collected)).toContain("property_address");
  });

  it("does not require the optional fields", () => {
    const collected = complete();
    expect(collected["insurance_carrier"]).toBeUndefined();
    expect(isBookable(collected)).toBe(true);
  });
});

describe("normalisePhone", () => {
  it("passes through plain digits", () => {
    expect(normalisePhone("5125551234")).toBe("5125551234");
  });

  it("strips formatting", () => {
    expect(normalisePhone("(512) 555-1234")).toBe("5125551234");
  });

  it("converts spoken digits", () => {
    expect(normalisePhone("five one two five five five one two three four")).toBe("5125551234");
  });

  it("handles a mix of spoken and grouped digits", () => {
    expect(normalisePhone("five one two 555 1234")).toBe("5125551234");
  });

  it("treats 'oh' as zero", () => {
    expect(normalisePhone("five oh three")).toBe("503");
  });

  it("drops a leading country code", () => {
    expect(normalisePhone("1 512 555 1234")).toBe("5125551234");
  });

  it("keeps a leading 1 that is part of a short string", () => {
    expect(normalisePhone("1234")).toBe("1234");
  });
});

describe("speakPhone", () => {
  it("groups a ten digit number the way people say it", () => {
    expect(speakPhone("5125551234")).toBe("512 555 1234");
  });

  it("spells out anything that is not ten digits", () => {
    expect(speakPhone("911")).toBe("9 1 1");
  });
});
