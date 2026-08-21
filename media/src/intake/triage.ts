/**
 * Deterministic emergency triage.
 *
 * This module exists because of one design decision, and it is the decision the
 * whole product rests on: **the language model is not allowed to decide whether
 * a call is an emergency.**
 *
 * A model asked "is this urgent?" is agreeable, inconsistent between
 * identically-worded calls, and steerable by a caller who is upset and
 * insistent. None of those are acceptable properties when the answer decides
 * whether someone gets woken up at 3am, and they are catastrophic when the
 * answer decides whether a family spends the night in a house with sewage in
 * it. So urgency is decided here, by rules that are readable, testable, and
 * identical on every call. The model's own assessment can only ever escalate
 * the result, never soften it.
 *
 * The rules are deliberately biased toward over-escalation. The asymmetry is
 * stark: a false positive costs the contractor one unnecessary phone call, and
 * a false negative costs a family's health, the contractor's insurance
 * position, and possibly their licence. When the two are that lopsided, tuning
 * for precision is the wrong instinct.
 *
 * Categories follow IICRC S500, which is the standard restoration contractors
 * actually work to and price against.
 */

export type Urgency =
  /** Book into the normal schedule. Nobody gets woken up. */
  | "routine"
  /** Same-day, but not immediate. Flag it prominently to the owner. */
  | "priority"
  /** Page the on-call technician now, whatever the hour. */
  | "dispatch_now"
  /** Do not let an agent handle this. Get a human on the line immediately. */
  | "transfer_human";

const RANK: Record<Urgency, number> = {
  routine: 0,
  priority: 1,
  dispatch_now: 2,
  transfer_human: 3,
};

/** Returns whichever urgency is more severe. Escalation is one-way. */
export function escalate(a: Urgency, b: Urgency): Urgency {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Water categories under IICRC S500. These drive both urgency and price, so
 * getting the category onto the job ticket matters commercially as well as
 * medically.
 */
export type WaterCategory =
  /** Clean water from a sanitary source: supply line, tap, tank. */
  | "cat1"
  /** Grey water with contaminants: dishwasher, washing machine, aquarium. */
  | "cat2"
  /** Black water: sewage, ground surface water, anything grossly unsanitary. */
  | "cat3";

export interface TriageRule {
  id: string;
  urgency: Urgency;
  /** Shown to the contractor so the escalation is explainable, never a black box. */
  reason: string;
  patterns: RegExp[];
  category?: WaterCategory;
}

/**
 * The rule table.
 *
 * Ordering does not matter: every rule is evaluated and the results combine by
 * taking the maximum urgency. That is intentional: rules must not be able to
 * cancel each other out, only to raise the floor.
 */
export const RULES: TriageRule[] = [
  {
    id: "hazard.gas",
    urgency: "transfer_human",
    reason: "Caller reports a gas smell. This is a utility emergency, not a restoration job",
    patterns: [/\bsmell(?:s|ing)?\s+(?:like\s+)?gas\b/, /\bgas\s+leak\b/, /\bsmell\s+of\s+gas\b/],
  },
  {
    id: "hazard.electrical",
    urgency: "transfer_human",
    reason: "Water and live electricity reported together: electrocution risk",
    patterns: [
      /\bspark(?:s|ing|ed)?\b/,
      /\bshock(?:ed|ing)?\b/,
      /\b(?:breaker|fuse)\s*(?:box|panel)\b/,
      /\belectrical\s+panel\b/,
      /\bwater\b[^.]{0,40}\b(?:outlet|socket|wiring|electric)/,
      /\b(?:outlet|socket|wiring)\b[^.]{0,40}\bwater\b/,
    ],
  },
  {
    id: "hazard.injury",
    urgency: "transfer_human",
    reason: "Someone may be hurt. This call needs a person, immediately",
    patterns: [
      /\b(?:someone|somebody|anyone|he|she|they|i)\s+(?:is\s+|was\s+|got\s+)?(?:hurt|injured|bleeding)\b/,
      /\bcall\s+9\s*1\s*1\b/,
      /\bambulance\b/,
      /\btrapped\b/,
      /\bunconscious\b/,
    ],
  },
  {
    id: "hazard.fire",
    urgency: "transfer_human",
    reason: "Active fire reported: emergency services first, restoration afterwards",
    patterns: [/\b(?:fire|it)\s+is\s+still\s+burning\b/, /\bstill\s+on\s+fire\b/, /\bactive\s+fire\b/],
  },
  {
    id: "hazard.structural",
    urgency: "dispatch_now",
    reason: "Possible structural failure: a saturated ceiling can come down without warning",
    patterns: [
      /\bceiling\b[^.]{0,30}\b(?:sag|sagging|bulge|bulging|bowing|coming down|collapse)/,
      /\b(?:sag|sagging|bulge|bulging|bowing)\b[^.]{0,30}\bceiling\b/,
      /\bcollaps(?:e|ed|ing)\b/,
      /\bfloor\b[^.]{0,20}\bgiving way\b/,
    ],
  },
  {
    id: "water.cat3.sewage",
    urgency: "dispatch_now",
    category: "cat3",
    reason: "Category 3 black water (sewage): a health hazard that cannot wait for morning",
    patterns: [
      /\bsewage\b/,
      // Bare "sewer" counts. A caller who says "I think it's the sewer" is
      // describing Category 3 water whether or not they reach for the phrase
      // "backed up", and requiring the phrase meant the single most important
      // escalation in the system missed the most natural way to report it.
      // Found by the harness on the sewage-2am scenario.
      /\bsewer\b/,
      /\bseptic\b/,
      /\bblack\s*water\b/,
      /\btoilet\b[^.]{0,30}\b(?:overflow|backed up)/,
    ],
  },
  {
    id: "water.cat3.flood",
    urgency: "dispatch_now",
    category: "cat3",
    reason: "Ground or surface flood water is Category 3 by definition under S500",
    patterns: [/\b(?:river|creek|storm\s*surge|ground\s*water)\b/, /\bflood(?:ed|ing)?\s+from\s+outside\b/],
  },
  {
    id: "water.active",
    urgency: "dispatch_now",
    reason: "Water is still flowing, and every minute of delay increases the loss",
    patterns: [
      /\bstill\s+(?:running|flowing|leaking|coming|pouring|going)\b/,
      /\bcan'?t\s+(?:shut|turn)\s+(?:it\s+)?off\b/,
      /\bwon'?t\s+(?:shut|turn)\s+off\b/,
      /\bdon'?t\s+know\s+(?:how|where)\s+to\s+(?:shut|turn)\s+(?:it\s+)?off\b/,
      /\bgushing\b/,
      /\bpouring\s+(?:in|out|through)\b/,
    ],
  },
  {
    id: "water.cat2",
    urgency: "priority",
    category: "cat2",
    reason: "Category 2 grey water: contaminated but not immediately hazardous",
    patterns: [/\bdishwasher\b/, /\bwashing\s+machine\b/, /\bwasher\b/, /\bsump\s*pump\b/, /\baquarium\b/],
  },
  {
    id: "water.cat1",
    urgency: "priority",
    category: "cat1",
    reason: "Category 1 clean water from a sanitary supply source",
    patterns: [
      /\bsupply\s+line\b/,
      /\bwater\s+heater\b/,
      /\bburst\s+pipe\b/,
      /\bpipe\s+burst\b/,
      /\bfrozen\s+pipe\b/,
      /\bfaucet\b/,
    ],
  },
  {
    id: "occupant.vulnerable",
    urgency: "dispatch_now",
    reason: "A vulnerable occupant is in the property, and displacement risk raises the priority",
    patterns: [
      /\b(?:baby|infant|newborn|toddler)\b/,
      /\b(?:elderly|my\s+mother|my\s+father|nursing\s+home)\b/,
      /\boxygen\b/,
      /\bwheelchair\b/,
      /\bimmunocompromised\b/,
    ],
  },
  {
    id: "property.uninhabitable",
    urgency: "dispatch_now",
    reason: "Property may be uninhabitable tonight, so the caller may need lodging arranged",
    patterns: [
      /\bnowhere\s+to\s+(?:sleep|stay|go)\b/,
      /\bcan'?t\s+stay\s+here\b/,
      /\bhotel\b/,
      /\bevacuat(?:e|ed|ing)\b/,
    ],
  },
];

/**
 * Words that flip the meaning of a match.
 *
 * "There's no sewage, it's just clean water from the heater" must not trip the
 * sewage rule. This is a shallow heuristic: it looks back a short window
 * before the match, and it will not catch every construction English can build.
 * That is an accepted limit rather than an oversight: because the failure mode
 * of a missed negation is over-escalation, and over-escalation is the cheap
 * direction, a simple guard that is easy to read beats a clever one that is
 * hard to reason about at 3am.
 */
const NEGATORS =
  /\b(?:no|not|isn'?t|aren'?t|wasn'?t|weren'?t|don'?t|doesn'?t|didn'?t|haven'?t|hasn'?t|can'?t|cannot|without|nothing|none|never)\b/;

/**
 * How far back to look for a negator, in characters.
 *
 * Deliberately short, about two or three words. A wider window starts
 * swallowing negators that belong to a neighbouring clause, so "I don't want to
 * wait, the sewer backed up" would suppress the sewage rule. Since a missed
 * escalation is the expensive direction, the window errs on the side of firing.
 */
const NEGATION_WINDOW = 16;

function isNegated(text: string, matchIndex: number): boolean {
  const start = Math.max(0, matchIndex - NEGATION_WINDOW);
  return NEGATORS.test(text.slice(start, matchIndex));
}

export interface TriageHit {
  ruleId: string;
  urgency: Urgency;
  reason: string;
  category?: WaterCategory;
  /** The span of caller speech that fired the rule, for the call record. */
  evidence: string;
}

export interface TriageResult {
  urgency: Urgency;
  /** Most severe water category seen, if any rule identified one. */
  category?: WaterCategory;
  hits: TriageHit[];
  /** True when anything fired that must bypass normal booking. */
  requiresHuman: boolean;
}

const CATEGORY_RANK: Record<WaterCategory, number> = { cat1: 0, cat2: 1, cat3: 2 };

/**
 * Run the rule table over a stretch of caller speech.
 *
 * Call this on the full accumulated transcript rather than the latest utterance
 * alone: the caller may mention the sewage in their first sentence and the
 * address in their fifth, and urgency established early must not decay.
 */
export function triage(transcript: string): TriageResult {
  const text = transcript.toLowerCase();
  const hits: TriageHit[] = [];

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      if (isNegated(text, match.index)) continue;

      hits.push({
        ruleId: rule.id,
        urgency: rule.urgency,
        reason: rule.reason,
        ...(rule.category ? { category: rule.category } : {}),
        evidence: match[0],
      });
      break; // One hit per rule is enough; the reason is the same either way.
    }
  }

  let urgency: Urgency = "routine";
  let category: WaterCategory | undefined;

  for (const hit of hits) {
    urgency = escalate(urgency, hit.urgency);
    if (hit.category && (!category || CATEGORY_RANK[hit.category] > CATEGORY_RANK[category])) {
      category = hit.category;
    }
  }

  return {
    urgency,
    ...(category ? { category } : {}),
    hits,
    requiresHuman: urgency === "transfer_human",
  };
}

/**
 * Combine deterministic triage with the model's own read of the call.
 *
 * The model gets a vote, but only upward. If the rules say `dispatch_now` and
 * the model says `routine`, the answer is `dispatch_now`. The model does not
 * get to talk the system out of an escalation it did not make in the first
 * place. This is the function that enforces the promise at the top of the file,
 * and it is the reason it is a two-line function with a name rather than an
 * inline `Math.max` somewhere in the session loop.
 */
export function applyModelOpinion(rules: TriageResult, modelUrgency: Urgency): TriageResult {
  const urgency = escalate(rules.urgency, modelUrgency);
  return { ...rules, urgency, requiresHuman: urgency === "transfer_human" };
}
