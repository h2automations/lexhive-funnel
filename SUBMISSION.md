# LexHive take-home — notes

**Funnel** https://lexhive.vercel.app/qualification-v1 · **Ops** https://lexhive.vercel.app/ops
**Repo** https://github.com/h2automations/lexhive-funnel · **Automation** `n8n/*.json` · **Tags** `gtm/*.json` · **Database** https://airtable.com/appGH8RYEydLFlyNA

## The decision everything follows from

The request is finished the moment Postgres commits. Meta and Airtable are
*deliveries*, not dependencies — `/api/lead` writes the lead, enqueues an outbox
row per destination and returns; a worker drains it on a 60-second n8n schedule.
No downstream outage can lose a lead, and no downstream latency is paid by the
person filling in the form.

## Assumptions

- US Social Security disability, since the reference funnel is SSDI. Phone
  numbers are normalised to E.164 and dropped rather than guessed at when
  invalid.
- The restricted-state list is the twelve states commonly restricted for legal
  lead gen. It lives in a `state_rules` table and is read on every submission,
  so compliance changes it with an `UPDATE` and no deploy.
- "Structured database" is Airtable via n8n, per the brief's house stack.

## Trade-offs

**Deduplication is server-authoritative.** `/api/lead` validates and persists
the stable submission UUID as `event_id`, then returns the database value; the browser Pixel fires with that exact value and the
drain sends the same one to the CAPI. Minting client-side and hoping the server
echoes it breaks silently on any retry — this way a mismatch is structurally
impossible.

**All browser tags live in GTM**, not in the code. The app publishes three
dataLayer events and the container fires Meta, GA4 and Clarity from them, so a
new vendor is a container change rather than a deploy. The trade: dedup now depends on the Pixel tag's Event ID field being
mapped to `{{DLV - event_id}}`, and if it isn't, nothing errors and every
conversion is counted twice. The container is exported into `gtm/` alongside
the n8n workflows so that field is reviewable in a diff rather than buried in
a UI.

**`event_time` is the conversion moment, not the delivery attempt.** The drain
retries with backoff to a 32-minute ceiling over six attempts, so stamping
`Date.now()` at delivery would report a retried lead in the wrong hour and,
after a long outage, push it outside the attribution window entirely — the
retry machinery quietly corrupting the data it exists to protect. The lead row
already knows when the person actually converted, so that is what is sent.

**Match keys are chosen, not maximised.** `ct` is not sent — the funnel has no
city, and filling it with the state costs match quality rather than adding it.
ZIP and gender *are* asked: one tap each, both
real keys. "Prefer not to say" maps to a value the CAPI client drops rather
than hashes, so opting out sends Meta nothing rather than a placeholder.

**n8n schedules the drain, not Vercel Cron.** Hobby caps cron at once a day,
useless for a 60-second retry loop — and the automation layer visibly
orchestrating recovery beats a hidden platform cron anyway.

**Health signals stay out of the ad platforms.** Meta flagged this domain under
its Business Tool Terms as *"associated with medical conditions"* — the real
constraint in this vertical. So browser events carry a step **ordinal** and
nothing more: not the answer, and not the question's semantic id, since
`question: "doctor"` feeds that classification itself. Same drop-off curve.
Semantic ids stay in `app_events`, our database rather than an ad platform's,
and contact fields are masked out of Clarity in the markup.

**Restriction is decided server-side.** The browser is told its disposition; it
never decides. A compliance rule enforced in client code is a compliance rule
one devtools console away from being ignored.

## Extra, beyond the brief

- **Partial saves** — every answer updates one lead row, so an abandoned funnel
  leaves a recoverable record and a per-step drop-off point.
- **`/ops`** — delivery health, p50/p95 latency, a replay button. Recovery has
  to be something a non-engineer can do at 2am; a delivery only an engineer with
  database access can replay isn't recoverable, it's logged.
- **Observability** — structured JSON logs, Sentry, and an `app_events` table
  for domain events. No personal data reaches any of them, enforced by a tested
  redactor rather than by every call site remembering.
- **Accessibility as a conversion argument** — 4rem targets, one question per
  screen, focus moved for screen readers, a rem scale so an enlarged device font
  actually enlarges the page. For people over 40 who can't work, usually on a
  phone, often with a vision impairment, legibility and completion rate are the
  same variable.
- **38 tests** over the compliance decision, CAPI normalization, the log
  redactor and the delivery-health thresholds — the four places a bug is silent
  rather than loud — plus a Playwright suite covering the same invariants from
  the outside, including `eid` on the wire.

## The failure we actually had

`PRODUCTION.md` named a stopped drain as the most likely silent failure here.
It then happened. This n8n instance blocks `$env` inside nodes, so
`{{ $env.PUBLIC_BASE_URL }}` did not throw — it resolved to the string
`[ERROR: access to env vars denied]`, and the workflow POSTed to that every
sixty seconds for a day. No error, no alert, `/ops` healthy, leads still
reaching Airtable only because `/api/lead` drains inline. The retry path simply
did not exist.

The prediction is now a mechanism. `/api/drain` stamps a heartbeat on every run
including empty ones; `/api/health` turns three signals into a 200 or a 503; a
separate five-minute workflow polls it, posts to a webhook, and fails its own
execution so the alert survives a webhook nobody configured. Liveness alone
would not have caught this — a drain that runs and fails every delivery keeps a
perfectly fresh heartbeat — which is why progress and dead letters are measured
and tested separately, and why the monitor doesn't live inside the workflow it
watches.

## Known gaps

`PRODUCTION.md` has the full list in priority order. The two I'd close first:
rate limiting and bot protection on `/api/lead` (it's public and unthrottled),
and real auth on `/ops` (a shared key guards a replay button).
