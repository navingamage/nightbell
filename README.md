# nightbell

An after-hours phone agent for water damage restoration contractors. It answers
the call, runs the full intake a restoration job actually needs, decides by
fixed rules whether someone gets woken up, and books the job or hands the caller
to a person.

> A *night bell* was the bell mounted outside a shop or a surgery, the one you
> rang when the door was locked and you needed someone anyway. The thing being
> rebuilt here is the person who used to be on the other side of it.

## Why this and not a general voice agent

A burst supply line at 2am is a five-figure job, and it goes to whoever picks up
the phone. Answering services take a name and a number, which means the
contractor still has to call back and conduct the real conversation before
deciding whether to get dressed. The intake *is* the work, and handing it to
someone who does not know what category three water is only moves it to 6am.

Picking one vertical is what makes the intake real rather than generic. By the
time the call ends, the ticket says whether it is Category 1, 2 or 3 under
IICRC S500, whether the water is still running, which rooms are affected, who
the carrier is, and whether anyone will be there to let the crew in. That is a
ticket a technician can act on without a second call.

## The part that matters

**The model does not decide whether a call is an emergency.**

Urgency comes from a deterministic rule table. The model gets a vote, and that
vote can only ever *raise* the result: `applyModelOpinion()` takes the maximum
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
  src/providers/  Deepgram, Cartesia, OpenRouter, behind swappable interfaces
  src/harness/    the scripted scenarios and the interactive caller
  recordings/     real calls, replayable as tests
control/    Control plane (Cloudflare Pages Functions + D1)
site/       Marketing site (static, its own Pages project)
docs/       Design notes
```

The split is not arbitrary. The media server holds a WebSocket open for the
duration of a call and pays a latency penalty for every hop, so it is a
long-lived region-pinned process. Everything else is request-shaped and runs on
Cloudflare.

## Talking to it yourself

```bash
source ~/.config/antipode/load-secrets.sh   # OPENROUTER_API_KEY
make call
```

You type what the caller says, and the agent's working is printed next to its
replies: which triage rule fired and on the caller's exact words, what it filed
and under which field, and how long the caller waited for the first audio. Hang
up with Ctrl-D and it prints the ticket a technician would be handed, including
anything still missing.

Everything below the session is the same code a real call runs, including the
turn-taking and the mark accounting that tells the agent when it has stopped
talking. The only thing faked above it is your voice. A call costs about half a
cent.

`make call SCRIPTED=1` runs the same thing with no key and no spend, against the
stand-in model. `make call MODEL=vendor/name` tries a different model.

## Calls that already happened

The six written scenarios cover the calls we thought of. Real callers do not
confine themselves to those: they ask to be put through to a plumber, they
answer a question that was not asked, they say "hello?" into a silence. Every one
of those is a call the agent either handled or did not, and once it is written
down it is a test.

```bash
make call SAVE=plumber-referral      # take a call, keep it
make replay                          # replay every recorded call
make replay LIVE=1                   # against the real model, which is the point
```

A recording is a scenario with provenance, so it runs through exactly the same
path as a written one, and `make demo` picks it up automatically. Saving seeds
the expectations from what the call actually did, which matters most when the
call went wrong: edit `expect` to say what should have happened, and the file is
a failing test until it does.

`media/recordings/plumber-referral.json` is the first one, and it is the call
that produced the last three fixes in here.

## Seeing it work, with no API key and no phone number

```bash
make install
make demo
```

That drives a real `Session` through six scripted calls and prints the
conversation with the machinery exposed next to it: which triage rule fired and
on which words, when urgency changed, and time-to-first-audio per turn:

```
  caller  I came downstairs and the basement is full of water, it smells
          terrible, I think it's the sewer, and it's still coming up
  agent   Okay, that's a serious one and I'm treating it as an emergency.
  agent   What's the address of the property?
  ⚡ dispatch_now: water.cat3.sewage, water.active
     "sewer" → Category 3 black water (sewage): a health hazard that cannot
               wait for morning
     "still coming" → Water is still flowing, and every minute of delay
                      increases the loss
```

Against a live model the variance in these runs is the script rather than the
agent: a caller who answers in fixed order cannot answer a question the model
decided to ask twice, so a run where it re-asks one thing can reach the read-back
with no turns left to confirm it. What the scripts measure exactly is the
machinery, since triage, escalation, the transfer paths and the booking gate do
not vary between runs.

Two things are checked on every scenario regardless of what it expects: that the
agent never goes silent on a caller turn, and that it never asks the same
question twice word for word. Both were real failures, and neither is visible in
the urgency or the outcome, which is how a call that was unusable to listen to
still passed everything it was measured on.

The scenarios in `media/src/harness/scenarios.ts` are the calls that matter
commercially and the ones that matter for safety: the 2am sewage backup that has
to page someone, the gas smell that must never be handled by an agent, and the
Tuesday quote request that must *not* wake anyone up. Add `--live` to swap the
scripted stand-in for a real model, and `--model=` to run the same six calls
against a different one.

The harness has already paid for itself five times. It found that
`water.cat3.sewage` required the phrase "backed up" and so missed a caller saying
"I think it's the sewer", the single most important escalation in the system,
missing the most natural way to report it. It then found that a `Session` which
never receives Twilio's `mark` events treats every caller turn as a barge-in and
silently discards the intake.

The first live runs found three more, all of which would have reached a customer.
Tool results feed back into the model so it can say something about them, and a
model that answers with another tool call gets another round, which nothing
bounded: one caller turn ran for forty-eight seconds, asking the same question
over and over while the turn never yielded. The per-turn state block, delivered
as an ordinary message, got read down the phone line, list markers and all. And a
provider returning 429 rejected both halves of the response while the session was
only ever going to await one of them, so an unhandled rejection took down the
whole process and every other call on it. All five are regression-tested now.

## Running the tests

```bash
make test          # 153 tests, no API keys, every provider is faked
make typecheck
```

The test suite covers the μ-law codec against the G.711 reference, the
turn-taking state machine, the triage rules, the OpenRouter wire format against
a fake server, and the session orchestration including the barge-in ordering
guarantee.

To run the media server against real providers you need keys for Deepgram,
Cartesia, OpenRouter and Twilio. See `media/src/config.ts` for the full list.
The process refuses to boot without them, deliberately: a voice agent with a
missing key does not fail visibly, it answers the phone and then fails on the
first turn.

Copy `media/.env.example` to `media/.env` and fill it in; the server and the
harness both read it at startup. Real environment variables take precedence, so
production is unaffected: on Fly these arrive as secrets and no file exists.
`make demo-live` needs only `OPENROUTER_API_KEY`.

## Choosing the model

The conversational layer goes through [OpenRouter](https://openrouter.ai), so
which model answers the phone is `OPENROUTER_MODEL` rather than a code change.
That matters more here than it would elsewhere: an intake turn is a short reply
over a growing transcript, which nearly every instruction-tuned model can do, and
what separates them on a phone call is time to first token and price. Neither
ranking holds still.

The way to choose is to run the scenarios, which takes about forty seconds and
costs a couple of cents:

```bash
cd media && npm run harness -- --live --model=google/gemini-2.5-flash-lite
```

The difference between models is not subtle, and it is not where you would
expect. `gemini-2.5-flash-lite` is a third of the price and holds a perfectly
natural conversation, but it loses the thread of the intake, asking for an
address it was given two turns earlier, and on one run it did not transfer a
caller who asked outright for a person. `gemini-2.5-flash` runs the intake and
transfers on request, and errs by escalating a Tuesday quote enquiry that should
have been left for the morning. Both are wrong some of the time; only one of them
is wrong in the direction this system is built to be wrong in, which is why it is
the default.

Neither is finished. The remaining failures are the prompt over-weighting
transfer, not the model, and that is the next thing to fix.

## An actual phone call

Three things the harnesses do not need, because they only fake the audio path:
speech recognition (Deepgram), speech synthesis (Cartesia), and a number with a
carrier behind it (Twilio). All three keys go in `media/.env`.

Twilio has to reach the media server over the public internet, so it also needs
a hostname:

```bash
cd media && fly deploy                   # or a tunnel, with PUBLIC_HOST set to it
```

Then point a Twilio number's voice webhook at `POST https://<host>/voice`. The
TwiML that comes back opens the media WebSocket to the same host, and from there
it is the same `Session` you already talked to.

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
