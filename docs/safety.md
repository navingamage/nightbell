# What the model is not allowed to decide

The central design decision in nightbell is a negative one: **the language model
does not decide whether a call is an emergency.**

This is not caution for its own sake. It follows from what the two kinds of
error actually cost.

## The asymmetry

A false positive is one unnecessary phone call to a technician who was asleep.
Annoying; recoverable; costs a contractor essentially nothing.

A false negative is a family spending the night in a house with sewage in it, a
ceiling coming down on someone in the morning, or a caller reassured that a gas
smell can wait. That is a health outcome, an insurance position, and possibly a
licence.

When the costs are that lopsided, the correct system is not the one with the
best accuracy. It is the one that is *predictably wrong in the cheap direction*.
Language models are not predictably anything. They are agreeable, they are
sensitive to phrasing, and a caller who insists "it's really not that bad" can
talk one down. That is exactly the wrong failure mode here.

## How it is enforced

Urgency comes from `intake/triage.ts`: a table of regular expressions with fixed
urgency levels, evaluated over the full accumulated caller transcript on every
turn. It is deterministic, identical on every call, and readable by a contractor
who wants to know why their phone rang.

The model is given a vote, since `record_details` accepts an `urgency_opinion`, but
that vote passes through `applyModelOpinion()`, which takes the *maximum* of the
two. The model can raise an urgency. It can never lower one.

```
rules say dispatch_now, model says routine  → dispatch_now
rules say routine,      model says priority → priority
```

There is deliberately no `set_urgency` tool. Naming a tool that way would hand
the model the authority this design exists to withhold, and a future maintainer
reading the tool list would reasonably assume the authority was intended.

Three details make this hold up in practice:

- **Triage runs on the whole call, not the latest utterance.** A hazard
  mentioned in the first sentence must not decay by the fifth. Tested.
- **Hard hazards bypass the model entirely.** Gas, sparking, injury and active
  fire transfer to a human without a model round trip ever happening.
- **Escalations are injected into the prompt as settled fact**, with the
  instruction not to reassess them and not to tell the caller it might be less
  serious than it is.

## Negation, and why it is deliberately shallow

The rules do check for negation, so "there's no sewage, it's clean water" does
not trip the sewage rule. The check is a short backward look for a negator,
about two or three words, and it will not catch every construction English can
build.

That is a considered limit rather than a gap. A missed negation over-escalates,
which is the cheap direction. A negation window wide enough to catch every case
starts swallowing negators from neighbouring clauses, as in "I don't want to
wait, the sewer backed up", which under-escalates, the expensive direction. Between a
clever heuristic that fails in the expensive direction and a simple one that
fails in the cheap direction, take the simple one. It is also the one a
contractor can be walked through on the phone.

## What is auditable

Every rule that fires is recorded with its id, its human-readable reason, and
the exact span of caller speech that matched, and all of it is stored on the
call record. An escalation is never a black box. If a contractor asks why they
were woken at 2am, the answer is a sentence and a quote, not a model call that
can never be reproduced.
