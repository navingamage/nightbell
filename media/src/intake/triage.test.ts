import { describe, expect, it } from "vitest";
import { type Urgency, applyModelOpinion, escalate, triage } from "./triage.js";

/** Convenience: the urgency the rules alone assign to a transcript. */
const u = (text: string): Urgency => triage(text).urgency;

describe("escalate", () => {
  it("returns the more severe of two urgencies", () => {
    expect(escalate("routine", "dispatch_now")).toBe("dispatch_now");
    expect(escalate("transfer_human", "routine")).toBe("transfer_human");
    expect(escalate("priority", "priority")).toBe("priority");
  });

  it("is commutative", () => {
    expect(escalate("priority", "dispatch_now")).toBe(escalate("dispatch_now", "priority"));
  });
});

describe("triage: hard hazards transfer to a human", () => {
  it("catches a gas smell", () => {
    expect(u("I think I smell gas in the basement")).toBe("transfer_human");
  });

  it("catches electrical hazards near water", () => {
    expect(u("there's water right by the breaker panel")).toBe("transfer_human");
    expect(u("the outlet was sparking")).toBe("transfer_human");
  });

  it("catches injury", () => {
    expect(u("my husband slipped and he is hurt")).toBe("transfer_human");
    expect(u("should I call 911")).toBe("transfer_human");
  });

  it("catches an active fire", () => {
    expect(u("part of it is still burning")).toBe("transfer_human");
  });
});

describe("triage: water categories", () => {
  it("classifies sewage as category 3 and dispatches", () => {
    const result = triage("the sewer backed up into the downstairs bathroom");
    expect(result.category).toBe("cat3");
    expect(result.urgency).toBe("dispatch_now");
  });

  it("classifies a septic problem as category 3", () => {
    expect(triage("our septic tank is overflowing").category).toBe("cat3");
  });

  it("classifies a bare mention of the sewer as category 3", () => {
    // Callers rarely say "category three" or even "backed up". They say "I
    // think it's the sewer", and that has to be enough.
    expect(triage("I think it's the sewer").category).toBe("cat3");
    expect(triage("it smells terrible, might be the sewer line").category).toBe("cat3");
  });

  it("classifies a dishwasher leak as category 2", () => {
    expect(triage("the dishwasher leaked all over the kitchen").category).toBe("cat2");
  });

  it("classifies a burst supply line as category 1", () => {
    expect(triage("a pipe burst under the sink").category).toBe("cat1");
  });

  it("keeps the most severe category when several are mentioned", () => {
    // A caller often lists everything at once. The worst one governs.
    const result = triage("the water heater went and then the sewer backed up too");
    expect(result.category).toBe("cat3");
  });

  it("treats outside flood water as category 3", () => {
    expect(triage("the creek came up into the yard and into the house").category).toBe("cat3");
  });
});

describe("triage: active loss", () => {
  it("dispatches when water is still running", () => {
    expect(u("it's still pouring in through the ceiling")).toBe("dispatch_now");
  });

  it("dispatches when the caller cannot stop it", () => {
    expect(u("I can't shut it off, I don't know where the valve is")).toBe("dispatch_now");
  });

  it("stays at priority once the water is stopped", () => {
    // Shut off and clean-water — real, billable, but nobody needs waking.
    expect(u("a supply line let go but I got the valve shut off")).toBe("priority");
  });
});

describe("triage: occupants and habitability", () => {
  it("escalates when an infant is in the property", () => {
    expect(u("we have a newborn in the house")).toBe("dispatch_now");
  });

  it("escalates when the caller has nowhere to sleep", () => {
    expect(u("we have nowhere to stay tonight")).toBe("dispatch_now");
  });
});

describe("triage: structural", () => {
  it("escalates a sagging ceiling", () => {
    expect(u("the ceiling is sagging in the living room")).toBe("dispatch_now");
  });

  it("escalates a bulging ceiling stated the other way round", () => {
    expect(u("there's a bulge in the ceiling")).toBe("dispatch_now");
  });
});

describe("triage: negation", () => {
  it("does not fire on explicitly denied sewage", () => {
    const result = triage("there's no sewage, it's clean water from the water heater");
    expect(result.category).toBe("cat1");
    expect(result.hits.some((h) => h.ruleId === "water.cat3.sewage")).toBe(false);
  });

  it("does not let a negator from a neighbouring clause suppress a real hazard", () => {
    // The negation guard looks back only a couple of words precisely so that
    // this still escalates: "don't" belongs to "want to wait", not to "sewer".
    expect(triage("I don't want to wait, the sewer backed up").category).toBe("cat3");
  });

  it("does not fire on a denied gas smell", () => {
    expect(u("I don't smell gas or anything like that")).not.toBe("transfer_human");
  });

  it("still fires when the negation belongs to a different clause", () => {
    // "not sure" attaches to the extent, not to the sewage.
    expect(triage("the sewer backed up, I'm not sure how far it spread").category).toBe("cat3");
  });
});

describe("triage: quiet calls", () => {
  it("returns routine for an ordinary enquiry", () => {
    const result = triage("hi, I wanted to get a quote for some water damage from last month");
    expect(result.urgency).toBe("routine");
    expect(result.hits).toHaveLength(0);
    expect(result.requiresHuman).toBe(false);
  });

  it("returns routine for an empty transcript", () => {
    expect(triage("").urgency).toBe("routine");
  });
});

describe("triage: evidence and explainability", () => {
  it("records what fired and why", () => {
    const result = triage("the sewer backed up in the basement");
    const hit = result.hits.find((h) => h.ruleId === "water.cat3.sewage");
    expect(hit).toBeDefined();
    expect(hit!.reason).toMatch(/black water/i);
    expect(hit!.evidence.length).toBeGreaterThan(0);
  });

  it("accumulates every rule that fired, not just the winner", () => {
    const result = triage("the sewer backed up and it's still pouring in, we have a baby here");
    const ids = result.hits.map((h) => h.ruleId);
    expect(ids).toContain("water.cat3.sewage");
    expect(ids).toContain("water.active");
    expect(ids).toContain("occupant.vulnerable");
  });
});

describe("applyModelOpinion", () => {
  it("lets the model escalate", () => {
    const rules = triage("just some damp in the corner");
    expect(rules.urgency).toBe("routine");
    expect(applyModelOpinion(rules, "priority").urgency).toBe("priority");
  });

  it("does not let the model de-escalate", () => {
    // The whole point of the module: a persuasive caller cannot talk the
    // system down out of an escalation the rules made.
    const rules = triage("the sewer backed up into the basement");
    expect(rules.urgency).toBe("dispatch_now");
    expect(applyModelOpinion(rules, "routine").urgency).toBe("dispatch_now");
  });

  it("keeps requiresHuman consistent after combining", () => {
    const rules = triage("some water in the basement");
    const combined = applyModelOpinion(rules, "transfer_human");
    expect(combined.requiresHuman).toBe(true);
  });

  it("preserves the hit list so the escalation stays explainable", () => {
    const rules = triage("the sewer backed up");
    expect(applyModelOpinion(rules, "routine").hits).toEqual(rules.hits);
  });
});
