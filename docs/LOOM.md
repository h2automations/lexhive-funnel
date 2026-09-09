# Loom script — 5 minutes

Not a feature tour. Three decisions, each with the failure it prevents, and one
live demonstration. The brief says they evaluate *"ownership, sharp
problem-solving, and good judgment"* — so the through-line is **why**, and the
screen is there to prove it.

**Before recording:** have four tabs open — the funnel, `/ops`, Meta Test
Events, and the repo on `api/lead.ts`. Submit one lead beforehand so `/ops` has
data. Close Slack.

---

## 0:00 — 0:30 · What it is

> "A Social Security disability funnel with server-side conversion tracking and
> a delivery layer built so a downstream outage can't lose a lead. I'll show the
> flow, then the three decisions I'd want to be asked about."

Screen: the funnel, mid-question.

## 0:30 — 1:15 · The flow, end to end

Click through two or three questions, submit.

> "Every answer updates one lead row, so an abandoned funnel still leaves a
> recoverable record and a per-step drop-off point. On submit, the lead is
> written to Postgres — and the request is finished right there. Meta and
> Airtable are deliveries, not dependencies."

Switch to `/ops`: the lead appears, both destinations delivered.

## 1:15 — 2:15 · Decision 1 — deduplication

Screen: Meta Test Events showing browser and server `Lead` deduplicated.

> "The server mints the `event_id`, stores it on the lead row and returns it.
> The browser fires the Pixel event with that exact value, and the drain sends
> the same one to the Conversions API.
>
> The usual pattern is to mint it client-side and have the server echo it back.
> That breaks silently on any retry or race — you get two events, no error, and
> a conversion counted twice. Making the server the source of truth means a
> mismatch is structurally impossible rather than merely unlikely."

If time allows, one line on match quality: `fbc` reconstructed from `fbclid`
using the session's first touch, since the cookie only exists after the Pixel
loads and anyone who bounces or blocks scripts never gets one.

## 2:15 — 3:15 · Decision 2 — the outbox

Screen: `supabase/schema.sql`, the `claim_outbox_batch` function.

> "One outbox row per destination, so Meta failing can't block Airtable. The
> claim uses `FOR UPDATE SKIP LOCKED`, so overlapping drain runs take disjoint
> sets and nothing is ever delivered twice. Attempts are incremented at claim
> time, so a worker that dies mid-flight burns an attempt instead of looping
> forever.
>
> Failures are classified: a Meta 4xx is dead on arrival, only 429s and 5xxs
> retry, with jittered backoff from one minute to thirty-two."

Switch to `/ops`, point at the Replay button.

> "And recovery is a button. A delivery that only an engineer with database
> access can replay isn't recoverable — it's just logged."

## 3:15 — 4:15 · Decision 3 — compliance

Screen: `api/_lib/qualification.ts`, then the test file.

> "Restricted states can't have contact details passed to a buyer. Three things
> I'd point at.
>
> One — the list is a database table read on every submission, so compliance
> changes it with an `UPDATE`, not a deploy. Two — the browser is *told* its
> disposition, it never decides; a compliance rule in client code is one
> devtools console away from being ignored. Three — an unknown state fails
> closed and is treated as restricted.
>
> This is also the part I tested hardest, because the failure is silent. An
> earlier version compared the full state name against two-letter codes, so no
> lead was ever restricted and nothing errored. `'New York'` truncated to two
> characters is `'NE'` — Nebraska, a real and *unrestricted* state. That's a
> compliance incident that reports success."

## 4:15 — 5:00 · Close

> "Beyond the brief: an ops surface with delivery latency, structured logging
> with a redactor that strips personal data at any depth — tested, because a log
> drain is a data export — and accessibility treated as a conversion argument,
> since the audience is people over 40 on a phone, often with a vision
> impairment.
>
> `PRODUCTION.md` covers what I'd do before real ad spend: rate limiting on the
> lead endpoint, real auth on `/ops`, and a dead-man's switch on the drain —
> because if the schedule stops, nothing errors and nothing is delivered. That's
> why the drain logs a heartbeat even when it processes nothing."

---

## If asked

- **"Why not do more in n8n?"** The durability boundary belongs in Postgres —
  a workflow engine on the critical path of a form submission is a lead you can
  lose. n8n does what it's good at: scheduling recovery and routing with the PII
  strip in front of Airtable.
- **"Why no router library?"** Two routes.
- **"What would you change?"** Contact capture one step earlier, as a real A/B
  test rather than a guess — the variant plumbing is already there.
