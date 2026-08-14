# Where the milliseconds go

A voice agent lives or dies on one number: how long the caller waits between
finishing their sentence and hearing the first syllable of the reply. Humans
hand the floor back and forth with gaps averaging around 200 ms. Past roughly
800 ms the pause reads as hesitation. Past 1.5 seconds people say "hello?" and
start talking again, which is worse than the delay itself, because now two
people are talking at once and the turn has to be repaired.

This is the budget the architecture is built around, and it is why the media
server is a region-pinned Node process on Fly rather than something serverless
at the edge.

## The chain

Every turn pays all of these, in order:

| Stage | Typical | Notes |
|---|---|---|
| Carrier → media server | 20–40 ms | One 20 ms frame, plus network. Fixed cost. |
| **Endpoint detection** | **380–1100 ms** | The big one. See below. |
| Media server → model, first token | 250–450 ms | Time to first token, not full generation. |
| Model → first complete sentence | 80–200 ms | Depends where the first sentence boundary falls. |
| Synthesis, time to first audio | 90–150 ms | Streaming; total generation time does not matter. |
| Media server → carrier | 20–40 ms | |
| **Total, first audio** | **~840–1880 ms** | |

## Endpointing dominates, and it is the cheapest thing to fix

Endpointing is not compute. It is *deliberate waiting* — silence held to be sure
the caller has actually finished rather than pausing mid-thought. It is the
single largest line in the budget and the only one that can be cut without
buying anything.

The trick is that the right amount of patience depends entirely on the question
just asked. "Is the water still running?" gets a one-word answer, and 380 ms of
silence afterwards is conclusive. "Tell me what happened" gets a narration with
pauses in it, and cutting at 380 ms means interrupting someone mid-sentence
while they describe their flooded basement.

So `intake/schema.ts` carries an endpoint profile per field, and the turn
controller switches between them as the conversation moves:

| Profile | Silence | Used for |
|---|---|---|
| `terse` | 380 ms | Yes/no, a digit, a choice |
| `detail` | 700 ms | A name, an address, a phone number |
| `open` | 1100 ms | "Tell me what happened" |

Roughly two thirds of intake questions are `terse` or `detail`, so the average
turn is meaningfully faster than a single conservative global setting would give,
without ever clipping the one question where patience actually matters.

## Why not the edge

Cloudflare Workers would be a natural fit for everything here except the audio
path, and the temptation to unify on it is real. Two things rule it out for the
media leg:

1. **Frames arrive every 20 ms for the duration of the call.** This is a
   long-lived, stateful, CPU-steady workload — the opposite of what per-request
   edge compute is priced and shaped for.

2. **Placement is not controllable.** An edge runtime may place the isolate
   near the *caller*, but every hop that matters goes to Twilio's media edge,
   Deepgram, Cartesia and the Anthropic API. Being close to the caller and far
   from those four is a net loss.

So the split is: Fly holds the socket and the real-time loop, pinned to `iad`
near Twilio's media edge; Cloudflare holds everything that is request-shaped —
the site, the dashboard, tenant config, call records. Each part runs where its
workload actually fits.

## What is measured

`Session` records time-to-first-audio for every turn into
`CallRecord.turnLatenciesMs`, and the control plane stores it per call. That is
deliberately the *caller's* number — from end-of-caller-speech to first byte of
agent audio — rather than a sum of component timings, because component timings
can all look healthy while the thing still feels slow to talk to.
