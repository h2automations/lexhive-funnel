# Production readiness

What this system would need before it carries real ad spend, in the order I
would do it, with the reasoning rather than a checklist.

The observability layer described in [Observability](#observability) is
**implemented** — logging, error tracking and a domain-event table are in the
code. Everything above it is sequenced work, not aspiration, and each item says
what breaks if it is skipped.

---

## Where the system already stands

The delivery layer is the part that is genuinely production-shaped. The lead is
committed to Postgres before any integration is touched; each destination has
its own outbox row, so Meta failing cannot block Airtable; `FOR UPDATE SKIP
LOCKED` means overlapping drains never double-deliver; attempts are burned at
claim time so a worker that dies mid-flight cannot loop; failures are classified
into retryable and dead; and recovery is a button on `/ops` rather than a SQL
statement.

The compliance path is table-driven and fails closed. The consent artifact
stores the wording, not just a version number.

The delivery path is now proven against the live site (2026-09-09): Playwright
submissions were drained and every row delivered — `meta_capi` 5/5, `n8n_airtable`
9/9, zero dead-lettered, both destinations healthy on `/ops`. The one gap the
probe exposed was trigger, not delivery: a fresh submission sat `pending` for
90+s because nothing was calling the drain (the n8n Outbox Drain schedule is
not running in the user's instance). `/api/lead` now self-triggers a bounded
drain sweep on every completed submission so a lead is not hostage to the
external scheduler; the schedule remains the backstop for retries and backlog.
Activating that schedule in n8n is still required (see `README.md`).

What follows is what stands between that and taking money for leads.

---

## Tier 1 — before the first ad dollar

### 1. Rate limiting and bot protection on `/api/lead`

Today the endpoint is public, unauthenticated and unthrottled. Anyone who views
source can POST leads into the Airtable base the sales team works from.

This is not a hypothetical for legal lead gen specifically. Junk leads are
charged back by buyers, and a fabricated lead carries a **TCPA consent record
saying someone agreed to be called** — a record that is now false, attached to a
phone number belonging to a real person who did not consent. The liability sits
with whoever generated it.

- Vercel WAF rate limiting, or an Upstash Redis sliding window keyed on IP and
  `external_id`: ~10 partial saves and 2 completions per IP per hour.
- Cloudflare Turnstile on the contact step. Invisible for real users, and it
  gives a signal to store alongside the consent record.
- An `Origin` check, so the endpoint only accepts submissions from our own page.

### 2. Real authentication on `/ops`

A single shared key, held in `sessionStorage`, protects a page with a **replay
button** on it. Anyone who has ever been sent that key has it permanently, and
there is no way to revoke one person's access or to know who replayed what.

Supabase Auth with an email allowlist, or Vercel's built-in password protection
as a stopgap. The `delivery.replayed` event already records that a replay
happened; with real auth it can record *who*.

### 3. A dead-man's switch on the drain

**The most likely silent failure in the whole system.** Delivery is triggered
by an n8n Schedule. If that workflow is deactivated, its credentials expire, or
the n8n instance goes down, then: no errors are raised, no alerts fire, `/ops`
looks healthy, the funnel keeps accepting leads — and nothing is delivered to
anyone. You find out when a client asks why they got no leads yesterday.

`/api/drain` now logs `drain.completed` on **every** invocation including empty
ones, precisely so its absence is detectable. What is missing is the monitor:

- A Better Stack heartbeat monitor expecting a ping every 60s, alerting after 5
  minutes of silence.
- Independently, a scheduled query alerting when the oldest `pending` outbox row
  is older than 10 minutes. This catches the case where the drain runs but fails
  to make progress, which a heartbeat alone will not.

Two mechanisms because they fail differently, and this is the failure that costs
the most per minute.

### 4. Backlog alerting, not just dead-letter alerting

Sentry is notified when a delivery dies. Nothing is said when deliveries are
merely *slow* — which is the far more common failure, and the one that quietly
turns a 60-second lead into a 40-minute lead. Speed-to-lead is the single
biggest driver of contact rate in this industry; a 40-minute delay is a
materially less valuable lead even though every row eventually reads
`succeeded`.

Alert on p95 delivery latency and on oldest-pending age, from
`delivery_metrics()`.

### 5. Security headers

None are set. For a page that collects a name, phone and consent record:

- `Referrer-Policy: strict-origin-when-cross-origin` — the landing URL contains
  `fbclid` and UTM parameters, and today those leak in the referrer of every
  outbound request.
- `Content-Security-Policy` restricting scripts to self and
  `connect.facebook.net`.
- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
  `Permissions-Policy` denying geolocation, camera and microphone.

Add them in `vercel.json`; it is a fifteen-minute change.

### 6. Drop the query-string secret

`/api/drain` accepts `?secret=` as well as the header, which writes the secret
into Vercel's access logs and any intermediary's. The header path works; delete
the fallback and rotate the value.

---

## Tier 2 — first week of real traffic

### 7. Migrations instead of a hand-run `schema.sql`

`schema.sql` is idempotent, which is good, but it is applied by a human pasting
it into the SQL editor. There is no record of what is applied to which
environment, and no way to review a schema change in a pull request.

Move to Supabase CLI migrations (`supabase/migrations/NNNN_*.sql`), applied in
CI. The current file becomes the initial migration.

### 8. A staging environment

There is one Supabase project, one Meta dataset, one deployment. Every test I
ran today wrote rows to the same database that would hold real claimants' data,
which is both a data-hygiene problem and a reason to be nervous about testing at
all — and a system nobody dares test is a system that breaks in production.

- A second Supabase project for preview deployments.
- A second Meta dataset for staging, so test traffic never touches the
  production dataset's optimisation signal.
- Vercel preview deployments already exist; point them at the staging project.

### 9. CI

Nothing currently prevents a broken deploy. `npm run verify` (typecheck, tests,
build) should run on every pull request via GitHub Actions, with deployment
gated on it. The ESM `require()` bug that dead-lettered every Meta delivery
would not have been caught by a typecheck — but it would have been caught by an
integration test that actually invoked the drain, which is item 10.

### 10. Tests beyond the redactor

`api/_lib/log.test.ts` exists because the PII guarantee must not be a
convention. The next most valuable, in order:

1. **Disposition logic** — restricted, disqualified and qualified from a table
   of answer sets. This is the compliance decision; it deserves a test that
   fails loudly. It is also the bug that shipped: `"New York"` tested against a
   set of two-letter codes, wrong for every single lead, and invisible.
2. **Backoff maths** — that six attempts span roughly an hour and that attempts
   are counted once, not twice.
3. **CAPI normalization** — email, phone, state and ZIP hashing, and that a 4xx
   is not retried while a 429 is. (A smoke test for this exists; it should live
   in the repo.)
4. **An integration test against a local Supabase**, exercising
   `/api/lead → outbox → /api/drain` with the Meta and n8n calls stubbed. This
   is the one that catches runtime failures a typechecker cannot see.

### 11. The client can still lose a lead

If `/api/lead` fails on submit, the funnel shows an error and the answers live
only in React state. If the person closes the tab, the lead is gone — despite
all the durability machinery behind it.

Persist the pending submission to `localStorage` and retry on next load. The
whole architecture is built on "never lose a lead"; this is the one place that
promise is still broken, and it is the cheapest to fix.

### 12. Data retention and erasure

`leads` grows forever and holds names, phones and emails indefinitely. For US
legal lead gen, CCPA deletion requests are a matter of when, not if.

- A documented retention period, and a scheduled purge that enforces it.
- A `delete_lead_by_identifier(email_or_phone)` function, so a deletion request
  is a procedure rather than an improvisation. `app_events` is already designed
  for this: its `lead_id` is `on delete set null`, so erasing a claimant leaves
  the delivery history intact and anonymous.
- Purge succeeded outbox rows older than 30 days; they are settled history and
  they slow every index that touches the table.

### 13. Backups you have actually restored

Supabase's daily backups are not point-in-time on the free tier, and a restore
that has never been rehearsed is a hope. Enable PITR and run one restore into a
scratch project so the runbook is written from experience.

---

## Tier 3 — as volume grows

- **Server-side GTM**, so the Pixel is proxied first-party instead of loading
  from `connect.facebook.net`. This is the single biggest remaining match-rate
  gain, because it survives tracking prevention that blocks the third-party
  script outright.
- **Dataset Quality API polling** into `/ops`, alerting when the Event Match
  Quality score drops. Match quality degrades silently and gradually; nobody
  notices from the ads dashboard until CPA has already moved.
- **Batch the CAPI calls.** Meta accepts up to 1,000 events per request; we send
  one. Fine at ten leads an hour, wasteful at a thousand.
- **Step-level drop-off reporting** from `app_events`. This is the number that
  decides which funnel variant to keep, and the data is already being recorded.
- **A real queue** (QStash, SQS) if outbox depth ever outpaces a 60-second poll.
  Not before — the outbox pattern is deliberately boring and the polling loop is
  its virtue, not its limitation.
- **Client-supplied idempotency key** on submit, so a double-tap or a retried
  request cannot create a second lead row. The unique `(lead_id, destination)`
  index already prevents duplicate *deliveries*; this closes the same gap one
  level up.

---

## Observability

Implemented. Three layers, because they answer three different questions.

### Structured logs → a drain

`api/_lib/log.ts`. One JSON object per line on stdout, which Vercel captures and
a drain (Better Stack, Axiom, Datadog) forwards.

The log line is an interface, not prose. `event:"delivery.failed"
destination:"meta_capi" error_code:"http_429"` is a query; *"Meta delivery
failed for lead abc"* is a needle in a haystack. Every line carries `ts`,
`level`, `service`, `env`, `release` (the commit SHA), `event`, `request_id` and
a duration.

**Vercel's own logs cannot be the system of record** — they roll off in hours.
The drain is.

`request_id` comes from `x-vercel-id`, is returned to the browser in an
`x-request-id` header, and is **stored on the outbox row**. A delivery that
succeeds forty minutes and three retries later can still be traced back to the
submission that created it.

### Error tracking → Sentry

`api/_lib/sentry.ts`. Logs tell you what happened; error tracking tells you what
broke, groups it, counts it and pages someone.

The distinction is not academic. The `require()`-in-ESM bug threw on **every**
Meta delivery, and produced: no failed HTTP request, no alert, no log anyone was
reading — just outbox rows quietly marked dead. Sentry would have grouped it as
one issue with a stack trace on the first delivery.

Sent as a Sentry envelope over `fetch` rather than via `@sentry/node`. The SDK's
value is breadcrumbs, tracing and auto-instrumentation; for capturing exceptions
out of three serverless handlers that costs a megabyte of cold start and a flush
lifecycle to manage, for a payload built here in forty lines. That trade-off
flips the moment anyone wants performance tracing — at which point swap the
module and leave the call sites alone.

Every report is awaited with a hard timeout, because a Vercel function can be
frozen the instant it responds, and a fire-and-forget report is a report that
sometimes doesn't arrive.

### Domain events → Postgres (`app_events`)

Deliberately *not* "logging to the database". This table holds the handful of
events worth joining against `leads` and `delivery_outbox`:

| Question | Answered by |
|---|---|
| How long from submit to the lead reaching Airtable, at p95? | `delivery.succeeded.duration_ms`, `queue_latency_ms` |
| Which destination fails, and with what? | `delivery.failed.error_code` |
| Which step do people abandon at? | `lead.created` / `lead.updated` step counts |
| Did that replay actually work? | `delivery.replayed` → `delivery.succeeded` |
| Is match quality degrading? | `lead.completed.detail.has_fbc` over time |

Those are joins, which is what a log vendor is bad at and Postgres is good at.
`delivery_metrics()` computes p50/p95 in the database and `/ops` renders it.

Events buffer in memory and flush in **one** insert before the handler returns:
one round trip, no rows lost to a frozen function, and no database latency on
the critical path of a form submission. A flush failure is logged and swallowed
— analytics must never be why a lead is lost.

### The PII rule: ids only, enforced not agreed

A log drain is a data export. It copies to a third-party vendor, is retained on
someone else's schedule, and is read by people with no business reason to see a
claimant's phone number.

So no personal data goes into logs, Sentry or `app_events`. Not names, emails,
phones, IPs, user agents, answers, consent wording, or the Meta identifiers that
single a person out. What does go in: `lead_id`, `disposition`, `state_code`,
timings, error codes, and booleans like `has_fbc`.

This is enforced in `redact()`, which strips forbidden keys at any depth from
everything logged — so `log.info('x', leadRow)` emits ids and `[redacted]`, and
a future call site cannot leak by being careless. Secrets are matched by
substring because credentials arrive under names nobody predicts:
`SUPABASE_SERVICE_ROLE_KEY` defeated an exact-match list on the first test run.
The matcher over-matches by design — a redacted field costs one debugging
session, a leaked service-role key costs the database.

`api/_lib/log.test.ts` proves it, including the realistic accident of logging a
whole lead row. **The guarantee is tested, not asserted.**

### What to alert on

Thresholds matter more than dashboards. Nobody watches a dashboard at 2am.

| Condition | Severity | Why |
|---|---|---|
| No `drain.completed` in 5 minutes | **Page** | Delivery has silently stopped |
| `state_rules.lookup_failed` | **Page** | Compliance routing is running blind |
| Oldest `pending` outbox row > 10 min | Sentry | Delivery is degraded, not dead |
| Any `delivery.dead` | Sentry | A lead needs a human to replay it |
| `lead.rejected` (`contact_required`) > 20% of completions | Sentry | The contact step is broken |
| p95 delivery latency > 30s | Ticket | Speed-to-lead is eroding |
| Meta EMQ drops below threshold | Weekly review | Match quality decays gradually |

The first two page because they are total, silent failures. The rest are
degradations, and waking someone for a degradation is how people learn to ignore
alerts.

---

## Deliberately not done

Worth stating, so their absence reads as a decision rather than an oversight.

- **No APM or distributed tracing.** Three serverless functions and one
  database. `request_id` correlation covers it; a tracing vendor would be
  ceremony.
- **No log aggregation service self-hosted.** Volume at this scale fits inside
  a free tier several times over.
- **No feature-flag system.** The variant lives in the URL path, which is enough
  for the A/B test the funnel is designed to run.
- **No queue.** The outbox is deliberately boring, and it is the right amount of
  machinery until depth outpaces a 60-second poll.
