# LexHive take-home — notes

**Funnel** https://lexhive.vercel.app/qualification-v1 · **Ops** https://lexhive.vercel.app/ops
**Repo** _<github url>_ · **Automation** `n8n/*.json` · **Database** _<Airtable link>_

## The decision everything follows from

The request is finished the moment Postgres commits. Meta and Airtable are
*deliveries*, not dependencies — `/api/lead` writes the lead, enqueues an outbox
row per destination and returns. A worker drains the outbox on a 60-second n8n
schedule. No downstream outage can lose a lead, and no downstream latency is
paid by the person filling in the form.

## Assumptions

- US Social Security disability, since the reference funnel is SSDI. Phone
  normalization assumes a US country code and drops anything that isn't ten
  digits rather than guessing.
- The restricted-state list is the twelve states commonly restricted for legal
  lead gen. It lives in a `state_rules` table and is read on every submission,
  so compliance changes it with an `UPDATE` and no deploy.
- "Structured database" is Airtable via n8n, per the brief's house stack.

## Trade-offs

**Deduplication is server-authoritative.** `/api/lead` mints the `event_id`,
stores it and returns it; the browser fires `fbq('track','Lead',…,{eventID})`
with that exact value and the drain sends the same one to the CAPI. The common
pattern — minting client-side and hoping the server echoes it — breaks silently
on any retry. This way a mismatch is structurally impossible.

**No city is sent to Meta.** The funnel doesn't collect one. Filling `ct` with
the state to have something there costs match quality rather than adding it. I
added a ZIP field instead: one input, and a real match key.

**n8n schedules the drain instead of Vercel Cron.** The Hobby plan caps cron at
once per day, useless for a 60-second retry loop — and it turned out to be the
better design anyway, because the automation layer visibly orchestrates recovery
instead of a hidden platform cron.

**Contact capture stays at the end**, matching the reference funnel. Moving it
one step earlier would enrich every subsequent event at some cost to completion.
That's an A/B test, not an assumption, and the variant plumbing is already
there — the variant is read from the URL path and lands on every lead row and
every Meta event.

**Health signals are kept out of the ad platforms.** Meta flagged this domain
under its Business Tool Terms as *"associated with medical conditions"* — the
real constraint in this vertical, and one the funnel's own questions provoke.
So the browser events carry a step **ordinal** and nothing more: never the
answer, and never the question's semantic id, because `question: "doctor"` is
itself a contribution to that classification. The ordinals give the same
drop-off curve; the semantic ids live in our `app_events` table, which is our
database rather than an ad platform's. Contact fields are masked out of Clarity
in the markup rather than by dashboard setting.

**Restriction is decided server-side.** The browser is told its disposition; it
never decides. A compliance rule enforced in client code is a compliance rule
one devtools console away from being ignored.

## Extra, beyond the brief

- **Partial saves.** Every answer updates one lead row, so an abandoned funnel
  leaves a recoverable record and a per-step drop-off point.
- **`/ops`** — delivery health, p50/p95 latency, and a replay button. Recovery
  has to be something a non-engineer can do at 2am; a delivery only an engineer
  with database access can replay isn't recoverable, it's logged.
- **Observability.** Structured JSON logs to a drain, Sentry for exceptions, and
  an `app_events` table for the domain events `/ops` reports on. No personal
  data reaches any of them — enforced by a redactor with tests, not by a
  convention every call site has to remember.
- **Accessibility as a conversion argument.** The audience is people over 40 who
  can't work, on a phone, often with a vision or motor impairment. 4rem targets,
  one question per screen, focus moved for screen readers, and a rem-based scale
  so enlarged device fonts actually enlarge the page. For this audience,
  legibility and completion rate are the same variable.
- **27 tests** covering the compliance decision, CAPI normalization and the log
  redactor — the three places where a bug is silent rather than loud.

## Known gaps

`PRODUCTION.md` has the full list in priority order. The three I'd close first:
rate limiting and bot protection on `/api/lead` (it's public and unthrottled),
real auth on `/ops` (a shared key guards a replay button), and a dead-man's
switch on the drain (if the n8n schedule stops, nothing errors and nothing is
delivered — which is why `drain.completed` logs on every run, including empty
ones, so its absence is detectable).
