# Loom script — 5 minutes

Five minutes is not enough to show everything, so this shows the three things
the brief says it grades — Meta event quality, reliability of the lead flow,
practical engineering decisions — and skips the rest. Anything not on screen is
in `SUBMISSION.md`.

Open these tabs before recording, in this order:

1. `https://lexhive.vercel.app/qualification-v1`
2. Events Manager → Test Events (browser test session already started)
3. Airtable — Leads, with the Restricted tab visible
4. n8n → LexHive Outbox Drain → Executions
5. `https://lexhive.vercel.app/api/health`
6. Supabase SQL editor, with the two statements from §5 pasted and unrun

---

## 0:00 — 0:35 · The one decision

> "A qualification funnel for Social Security disability. Everything here
> follows from one decision: the request is finished the moment Postgres
> commits. Meta and Airtable aren't dependencies, they're deliveries. The API
> writes the lead and enqueues an outbox row per destination, so no downstream
> outage can lose a lead. There's one deliberate exception — a completed
> submission also runs a bounded four-second drain sweep before responding,
> because Vercel can freeze an invocation the moment it returns and work
> started after the response isn't guaranteed to run. The person waits a moment
> rather than the delivery being silently dropped."

Show `api/lead.ts` for three seconds — the insert, the enqueue, the return.
Don't read it aloud.

## 0:35 — 1:35 · The funnel, one qualified lead

Drive it. Texas, all qualifying. While answering:

> "One question per screen, 4rem targets, focus moves to each new question. The
> audience is people over 40 who can't work, usually on a phone, often with a
> vision impairment — legibility and completion rate are the same variable
> here, so this is a conversion argument, not a compliance checkbox."

Open devtools on the state question:

> "This one waits for the server. The browser never decides whether a state is
> restricted — a compliance rule enforced in client code is one devtools
> console away from being ignored."

Submit. Land on Thank you.

## 1:35 — 2:15 · Restricted, and what the browser never sees

New session, New York.

> "Same funnel, different state."

Land on the restricted screen. Open devtools, show the form has exactly one
input.

> "The contact fields aren't hidden, they were never rendered — and the
> completion request carries no contact object at all. There's a second strip
> in the n8n layer too, because one enforcement point is a single point of
> failure for the thing you least want to get wrong."

## 2:15 — 3:15 · Meta — the part you said you care about

Events Manager, Lead event.

> "Match quality 8.0. Browser and server both reporting."

Open Test Events. Point at the single deduplicated Lead.

> "One conversion, received twice — browser Pixel and Conversions API — and
> collapsed into one because both carry the same event ID. That ID is minted
> server-side and persisted before it's returned; the browser fires with the
> value the database gave it. Minting client-side and hoping the server echoes
> it breaks silently on any retry."

Then:

> "Two decisions worth naming. Event time is the conversion moment, not the
> delivery attempt — the drain retries out to thirty-two minutes, so stamping
> the send would report a retried lead in the wrong hour and, after a long
> outage, outside the attribution window entirely. And Meta flagged this domain
> under its Business Tool Terms as associated with medical conditions, so the
> browser events carry a step ordinal and nothing else: not the answer, not the
> question's ID. Same drop-off curve, no health signal leaving the building."

## 3:15 — 3:55 · n8n → Airtable

n8n execution, then Airtable.

> "The drain calls the API, the API delivers to Meta and to this n8n webhook,
> and n8n routes on disposition."

Switch to the Restricted table. Scroll the columns.

> "This table has no contact columns. Not a hidden view — the fields don't
> exist. If it's a filter, it's one click from being undone by anyone with
> access."

## 3:55 — 4:45 · The failure we actually had

This is the beat worth rehearsing.

> "I wrote a production doc listing what would break first, and said a stopped
> drain was the most likely silent failure in the system. Then it happened. n8n
> blocks environment variables inside nodes, so the URL expression didn't throw
> — it resolved to the literal string 'error, access to env vars denied', and
> the workflow POSTed to that every sixty seconds for a day. No error, no
> alert, ops page green, leads still arriving because the API also drains
> inline. The retry path just quietly didn't exist."

Run statement 1 in Supabase:

```sql
update public.app_config set drain_last_ok_at = now() - interval '1 hour' where id = 1;
```

Refresh `/api/health`. It's a 503.

> "So now there's a heartbeat. I've just aged it by an hour — the endpoint goes
> 503, and the monitor workflow alerts and fails its own execution, so it still
> shouts even if nobody configured a webhook. Three signals, not one: is it
> running, is it making progress, and has anything been given up on. Liveness
> alone wouldn't have caught this — a drain that runs and fails every delivery
> keeps a perfectly fresh heartbeat."

Wait for the next drain tick, refresh, 200.

> "And it heals itself, because the next successful drain stamps it again."

## 4:45 — 5:00 · Close

> "Config's in Supabase rather than env vars, so rotating the drain secret is
> one UPDATE. Thirty-eight unit tests over the four places a bug here is silent
> rather than loud, and a Playwright suite that checks the same invariants from
> the outside — including whether the event ID is actually on the wire, because
> that's a GTM field that fails with a green tick.
>
> Next two things I'd do: rate limiting on the public endpoint, and real auth on
> the ops page. Both are in the production doc, in priority order."

---

## Notes

Don't demo the ops page. It duplicates what `/api/health` already showed and
costs forty seconds you need elsewhere.

If you overrun, cut §3:15 to fifteen seconds — one sentence over the Airtable
row. Do not cut §3:55. The incident is the most senior thing in this
submission: a prediction, a real failure, and the mechanism that closes it.

Say "I don't know" if asked something you don't. It reads better than a guess,
and the brief says they'll ask how the code works.
