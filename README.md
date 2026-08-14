# nightbell

An after-hours phone agent for water damage restoration contractors. It answers
the call, runs the full intake a restoration job actually needs, decides by
fixed rules whether someone gets woken up, and books the job or hands the caller
to a person.

> A *night bell* was the bell mounted outside a shop or a surgery — the one you
> rang when the door was locked and you needed someone anyway. The thing being
> rebuilt here is the person who used to be on the other side of it.

## Why this and not a general voice agent

A burst supply line at 2am is a five-figure job, and it goes to whoever picks up
the phone. Answering services take a name and a number, which means the
contractor still has to call back and conduct the real conversation before
deciding whether to get dressed — the intake *is* the work, and handing it to
someone who does not know what category three water is only moves it to 6am.

Picking one vertical is what makes the intake real rather than generic. By the
time the call ends, the ticket says whether it is Category 1, 2 or 3 under
IICRC S500, whether the water is still running, which rooms are affected, who
the carrier is, and whether anyone will be there to let the crew in. That is a
ticket a technician can act on without a second call.

## The part that matters

**The model does not decide whether a call is an emergency.**

Urgency comes from a deterministic rule table. The model gets a vote, and that
vote can only ever *raise* the result — `applyModelOpinion()` takes the maximum
of the two, so a persuasive caller cannot talk the system down out of an
escalation the rules made. Hard hazards (gas, sparking, injury, active fire)
transfer to a human without a model round trip happening at all.

The reasoning is that a false positive costs one unnecessary phone call and a
false negative costs a family's night, so the system should be predictably wrong
in the cheap direction rather than accurate on average. Every escalation records
which rule fired and the caller's exact words that fired it.

The full argument, including why the negation handling is deliberately shallow,
is in [docs/safety.md](docs/safety.md).

## The other part that matters

Turn-taking, which is what separates an agent that feels like a person from one
that feels like a phone tree. Almost none of it is model quality:

- **Endpointing is per-question.** "Is the water still running?" cuts at 380 ms;
  "tell me what happened" waits 1100 ms. A single global setting is either too
  slow on every short answer or interrupts the one question that matters.
- **Barge-in is harder to trigger than mere energy.** "Mm-hm" over the top of an
  address read-back is agreement, not an interruption, and an agent that can
  never finish a sentence is the most irritating failure mode in the category.
- **Interrupting clears the carrier's queue.** Stopping generation does nothing
  about audio already handed to Twilio; without an explicit `clear` the agent
  keeps talking over the caller for as long as the buffer lasts.

Where the milliseconds actually go is in [docs/latency.md](docs/latency.md).

## Layout

```
media/      Real-time media server (Node/TypeScript, Fly.io)
  src/call/       audio codec, turn-taking, playback pacing, session
  src/intake/     intake script, triage rules, model tools
  src/providers/  Deepgram, Cartesia, Claude, behind swappable interfaces
control/    Control plane (Cloudflare Pages Functions + D1)
site/       Marketing site (static, its own Pages project)
docs/       Design notes
```

The split is not arbitrary. The media server holds a WebSocket open for the
duration of a call and pays a latency penalty for every hop, so it is a
long-lived region-pinned process. Everything else is request-shaped and runs on
Cloudflare.

## Seeing it work, with no API key and no phone number

```bash
make install
make demo
```

That drives a real `Session` through six scripted calls and prints the
conversation with the machinery exposed next to it — which triage rule fired and
on which words, when urgency changed, and time-to-first-audio per turn:

```
  caller  I came downstairs and the basement is full of water, it smells
          terrible, I think it's the sewer, and it's still coming up
  agent   Okay, that's a serious one and I'm treating it as an emergency.
  agent   What's the address of the property?
  ⚡ dispatch_now — water.cat3.sewage, water.active
     "sewer" → Category 3 black water (sewage) — a health hazard that cannot
               wait for morning
     "still coming" → Water is still flowing — every minute of delay increases
                      the loss
```

The scenarios in `media/src/harness/scenarios.ts` are the calls that matter
commercially and the ones that matter for safety: the 2am sewage backup that has
to page someone, the gas smell that must never be handled by an agent, and the
Tuesday quote request that must *not* wake anyone up. Add `--live` to swap the
scripted stand-in for real Claude.

The harness has already paid for itself twice. It found that `water.cat3.sewage`
required the phrase "backed up" and so missed a caller saying "I think it's the
sewer" — the single most important escalation in the system, missing the most
natural way to report it. It then found that a `Session` which never receives
Twilio's `mark` events treats every caller turn as a barge-in and silently
discards the intake. Both are regression-tested now.

## Running the tests

```bash
make test          # 130 tests, no API keys — every provider is faked
make typecheck
```

The test suite covers the μ-law codec against the G.711 reference, the
turn-taking state machine, the triage rules, and the session orchestration
including the barge-in ordering guarantee.

To run the media server against real providers you need keys for Deepgram,
Cartesia, Anthropic and Twilio — see `media/src/config.ts` for the full list.
The process refuses to boot without them, deliberately: a voice agent with a
missing key does not fail visibly, it answers the phone and then fails on the
first turn.

## Deployment

Two independent deploys.

**Media server** → Fly.io, pinned to `iad`:

```bash
cd media && fly deploy
```

**Control plane** → Cloudflare Pages with a D1 binding:

```bash
cd control
npm run db:migrate:remote
npm run deploy
```

The site in `site/` is its own Cloudflare Pages project, served at
`nightbell.antipodetech.com`. DNS and custom-domain attachment are done in the
Cloudflare dashboard.

## Status

Pre-beta. The call loop, triage, and intake are built and tested. Not yet
carrying live customer calls.
