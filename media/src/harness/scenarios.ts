/**
 * Scripted calls for the offline harness.
 *
 * Each scenario is a sequence of caller utterances plus the outcome the system
 * is supposed to reach. They are written from the calls that actually matter
 * commercially and the ones that matter for safety: the 2am sewage backup that
 * has to page someone, the gas smell that must never be handled by an agent,
 * and the mundane Tuesday quote request that must *not* wake anyone up.
 *
 * These double as documentation. Reading the list tells you what the product
 * claims to handle better than any prose does.
 */

export interface Scenario {
  id: string;
  title: string;
  /** Why this call is worth having a test for. */
  note: string;
  /**
   * What the caller says, in the order the intake asks for it.
   *
   * The agent drives the conversation, so a scripted caller answers in script
   * order. Real callers volunteer things early and out of sequence, and the
   * `situation` answers below do exactly that, but a scenario that wandered
   * freely would be testing the model's extraction rather than the machinery
   * this harness exists to make visible.
   *
   * A scenario that expects a booking ends with the caller confirming the
   * read-back, because the agent is forbidden to book before that confirmation.
   * Leave it off and the call is correct in every respect and still unbooked.
   */
  utterances: string[];
  expect: {
    urgency: "routine" | "priority" | "dispatch_now" | "transfer_human";
    outcome: "booked" | "transferred" | "abandoned" | "in_progress";
    /** Triage rules that must have fired. */
    rules?: string[];
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: "sewage-2am",
    title: "Category 3 backup, water still active, 2am",
    note: "The call the whole product exists for. Must page the on-call tech.",
    utterances: [
      "yeah hi, it's five one two five five five oh one four four",
      "Dana Whitfield",
      "I came downstairs and the basement is full of water, it smells terrible, I think it's the sewer, and it's still coming up",
      "400 west Cesar Chavez",
      "it's a house",
      "no it's still coming in, I can't stop it",
      "I think the main line out to the street",
      "maybe twenty minutes ago",
      "the whole basement, and it's coming up the stairs now",
      "yeah there's a good four inches down there",
      "State Farm",
      "no I haven't called them yet",
      "yeah I'll be here all night",
      // The agent is required to read the address and number back and wait for
      // a yes before booking, so a script that stops at the last question can
      // never reach a booking. This is the caller confirming the read-back.
      "yeah that's right",
    ],
    expect: {
      urgency: "dispatch_now",
      outcome: "booked",
      rules: ["water.cat3.sewage", "water.active"],
    },
  },
  {
    id: "gas-smell",
    title: "Caller reports a gas smell",
    note: "Must transfer to a human immediately, without a model round trip.",
    utterances: [
      "hi, uh, there's water in my utility room",
      "and honestly I think I smell gas down there too",
    ],
    expect: { urgency: "transfer_human", outcome: "transferred", rules: ["hazard.gas"] },
  },
  {
    id: "clean-water-contained",
    title: "Supply line burst, already shut off",
    note: "Real work, real money, but nobody needs waking. Books for the morning.",
    utterances: [
      "five one two five five five nine nine one two",
      "Marcus Webb",
      "a supply line under the kitchen sink let go, but I got the valve shut off",
      "1100 south lamar, apartment 4B",
      "it's an apartment",
      "no, it's stopped now",
      "the supply line under the sink",
      "about an hour ago",
      "the kitchen and a bit of the hallway",
      "no standing water, it's just soaked into everything",
      "yeah, it's Allstate",
      "not yet, I'll call them in the morning",
      "yeah I'm home",
      "yep, that's all correct",
    ],
    expect: { urgency: "priority", outcome: "booked", rules: ["water.cat1"] },
  },
  {
    id: "quote-request",
    title: "Tuesday afternoon quote enquiry",
    note: "The negative case. An agent that escalates this is worse than useless.",
    utterances: [
      "hi, I had some water damage last month and I'm looking to get a quote on repairs",
      "no it's all dried out now, I just want someone to look at the drywall",
    ],
    expect: { urgency: "routine", outcome: "in_progress" },
  },
  {
    id: "vulnerable-occupant",
    title: "Clean water, but there is a newborn in the house",
    note: "Category 1 alone is priority; the occupant is what makes it a dispatch.",
    utterances: [
      "five one two five five five three three one two",
      "the water heater burst in the garage",
      "we have a newborn here and I don't want her breathing anything",
    ],
    expect: {
      urgency: "dispatch_now",
      outcome: "in_progress",
      rules: ["water.cat1", "occupant.vulnerable"],
    },
  },
  {
    id: "asks-for-human",
    title: "Caller just wants to talk to a person",
    note: "Never negotiate with this. Transfer on the first ask.",
    utterances: ["can I just talk to an actual person please"],
    expect: { urgency: "routine", outcome: "transferred" },
  },
];
