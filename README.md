# LexHive — Growth Automation take-home

A Social Security disability qualification funnel with server-side conversion
tracking and a delivery layer built so that a downstream outage cannot lose a
lead.

**Live funnel:** https://lexhive.vercel.app/qualification-v1
**Delivery health:** https://lexhive.vercel.app/api/health *(unauthenticated, returns 200 healthy / 503 degraded)*
**Ops view:** https://lexhive.vercel.app/ops *(needs `OPS_KEY`)*

---

## Where the deliverables are

| Deliverable | Where |
|---|---|
| The written note | [`SUBMISSION.md`](./SUBMISSION.md) — **start here** |
| Loom script and what it demonstrates | [`docs/LOOM.md`](./docs/LOOM.md) |
| Automation export | [`n8n/`](./n8n) — outbox drain, lead routing, delivery monitor |
| Database export | [`supabase/schema.sql`](./supabase/schema.sql); [`supabase/verify.sql`](./supabase/verify.sql) reports the live state of every object it creates |
| Tag configuration | [`gtm/GTM-P34XGVL3.json`](./gtm) — the full container export |
| Tests | [`tests/README.md`](./tests/README.md) — 56 unit tests, 32 Playwright |
| What this needs before real ad spend | [`PRODUCTION.md`](./PRODUCTION.md) |

Configuration that exists only inside someone's GTM, n8n or Supabase account is
configuration nobody can review. That is why all four are exported into the
repository rather than described in prose.

---

## The one decision

```
Browser (React + Vite, Vercel)
   │  attribution captured on landing, progress saved on every step
   ▼
POST /api/lead
   │  1. insert or update ONE lead row      ← durability boundary; returns here
   │  2. on completion, enqueue delivery_outbox rows
   ▼
POST /api/drain  (n8n Schedule, every 60s)
   │  claim_outbox_batch() — FOR UPDATE SKIP LOCKED
   ├──► Meta Conversions API      dedup via shared event_id (Lead | NurtureOptIn)
   └──► n8n webhook ──► Airtable  upsert on Lead ID, Sales | Nurture | None
             │
             └─ failure ──► exponential backoff ──► dead-letter ──► /ops + Sentry
```

**The request is finished the moment Postgres commits.** Meta and Airtable are
deliveries, not dependencies. Everything else in this repository follows from
that one sentence.

There is one deliberate exception: a completed submission also runs a bounded
four-second drain sweep before responding. Vercel can freeze an invocation the
moment it returns, so work started after the response is not guaranteed to run.
The person waits a moment rather than the delivery being silently dropped.

---

## Tracking quality

### Deduplication

One conversion, sent twice, counted once. The browser proposes a submission
UUID; the database decides it.

```text
Browser mints submission_id ──► POST /api/lead
                                    │  validates it is a UUID
                                    │  persists it as leads.event_id
                                    │  re-reads the stored value
                                    ▼
                          returns the PERSISTED event_id
                                    │
        ┌───────────────────────────┴───────────────────────────┐
        │ Browser / Meta Pixel              Server / Meta CAPI   │
        │ event_name = Lead                 event_name = Lead    │
        │ event_id   = ABC123               event_id   = ABC123  │
        └───────────────────────────┬───────────────────────────┘
                                    ▼
                           Meta deduplication
```

The Pixel fires with what came back, not with what it sent. That distinction is
the whole design: on a retry the second request finds the completed row and is
handed the *first* attempt's id, so a person who submits twice still produces
one conversion. Delivery retries reuse the same id too — it is written once into
`delivery_outbox.payload` at enqueue and the failure path never rewrites it.

With tags in GTM, the browser half of that contract is a single field: the Meta
Pixel tag's **Event ID** must map to `{{DLV - event_id}}`. Unmapped, nothing
looks wrong — no error, a green tick in Preview — and every conversion is
counted twice. `tests/tags.spec.ts` asserts the `eid` parameter on the live wire
for exactly that reason.

A second silent failure sits beside it: the browser gets its pixel id from the
container and the server from `META_PIXEL_ID`. If those ever name different
pixels, both events send, both return success, and they land in different places
and never meet. `/api/health` publishes the server's id — it is public, it is in
every visitor's page source — and the same test asserts the browser matches it.
The live pixel is `3238075189714579`.

### What the tags are not given

The funnel asks whether someone is unable to work because of a medical
condition, and Meta has classified this domain under its Business Tools Terms as
associated with medical conditions. So the dataLayer carries the **step ordinal
and nothing else** — never the answer, never the question's semantic id, since a
variable reading `question: "doctor"` feeds the very classification that caused
the flag. The drop-off curve is identical either way; semantic ids live in
`app_events`, which is our database rather than an ad platform's.

Contact fields carry `data-clarity-mask` in the markup rather than relying on a
session recorder's default masking, because a default is not a control. No tag
fires on `/ops` — counting 2am debugging as campaign traffic distorts exactly
the numbers spending decisions are made on.

### Match keys and normalization

Sent hashed: `em`, `ph`, `fn`, `ln`, `st`, `zp`, `ge`, `country`, `external_id`,
each normalized first. Sent unhashed, as Meta requires: `client_ip_address`,
`client_user_agent`, `fbp`, `fbc`.

Normalization is not cosmetic. `st` is the two-letter code lowercased and `zp`
the five-digit ZIP: a hash of `"New York"` matches nothing and fails with no
error. `ct` (city) is **not** sent — the funnel does not collect one, and
filling the field with the state to have something there costs match quality
rather than adding it.

**`fbc` reconstruction.** When `_fbc` is absent but `fbclid` is in the URL, the
value is rebuilt as `fb.<subdomain_index>.<first_seen_ms>.<fbclid>` — using the
session's first touch rather than the current time, and deriving the index from
the hostname rather than hardcoding it. Meta writes `fb.2.…` on
`lexhive.vercel.app`, and a constant `1` is a near-miss that costs match quality
without ever raising an error. This is the largest match-quality gain available
here and is routinely missed, because the cookie only exists after the Pixel
script loads — visitors who bounce, block scripts, or submit quickly never get
one.

**Attribution timing.** `fbclid`, UTMs and referrer are captured on the first
pageview and persisted; the query string is gone after the first route change.
Cookie identifiers are re-read at submit, since the Pixel often writes `_fbp`
after first paint.

**`event_time`** is the conversion moment from the lead row, not the moment the
delivery attempt runs. With a 32-minute backoff ceiling over six attempts, the
difference is the wrong reporting hour at best and a missed attribution window
at worst.

**`external_id`** is a first-party session UUID, published on the dataLayer for
the Pixel's advanced matching and sent hashed from the server. It survives
cookie loss mid-funnel and costs nothing.

### One conversion event, not two

The app pushes `application_submitted` on every completion and `qualified_lead`
only when the lead is actionable. Only the second becomes a Meta `Lead`. A
browser-only `SubmitApplication` would have no CAPI half, nothing to
deduplicate against, and would add a second conversion signal from a
health-flagged domain. The gap between the two is measured in GA4 instead, where
it is a product metric rather than an optimisation signal.

---

## Reliability

| Mechanism | Purpose |
|---|---|
| Write-ahead to Postgres | The lead is safe before any integration is touched |
| Outbox row per destination | Meta failing cannot block Airtable, or vice versa |
| `FOR UPDATE SKIP LOCKED` | Overlapping drain runs never double-deliver |
| Unique `(lead_id, destination)` | A double submit cannot enqueue the same event twice |
| Attempts incremented at claim | A worker that dies mid-flight burns an attempt rather than looping |
| 5-minute lease | Rows stuck in `delivering` self-release |
| Jittered exponential backoff | 1m → 32m, no retry stampede |
| `retryable` classification | Meta 4xx is dead on arrival; only 429/5xx retry |
| Dead-letter + `/ops` replay | Bounded failure, visible and replayable by a human |
| `/api/health` + monitor workflow | Liveness, progress and loss — three signals, not one |

`attempts` is incremented in exactly one place: `claim_outbox_batch`. The worker
reads it and never adds to it. Incrementing in both spends two attempts per
failure and skips every other rung of the backoff ladder, turning a six-attempt
budget into three — invisible until an outage runs long.

**The failure we actually had.** `PRODUCTION.md` predicted that a stopped drain
was the most likely silent failure in this system. Then it happened: n8n blocks
environment variables inside nodes, so the URL expression did not throw — it
resolved to the literal string `[ERROR: access to env vars denied]` and the
workflow POSTed to that every sixty seconds for a day. No error, no alert, ops
page green, leads still arriving because the API also drains inline. The retry
path simply did not exist.

`/api/health` is what closes it, and it checks three things rather than one:
is the drain running (heartbeat age), is it making progress (oldest waiting
outbox row), and has anything been given up on (dead-lettered rows). Liveness
alone would not have caught this — a drain that runs and fails every delivery
keeps a perfectly fresh heartbeat. Config moved out of `$env` and into a
Supabase `app_config` row, so rotating the drain secret is one `UPDATE`.

**Progress saves.** Every answer updates the same lead row: the first save
returns an id, each later one sends it back. An abandoned funnel leaves one
recoverable record with the step it stopped at, rather than six rows inflating
every count on `/ops`.

---

## Privacy and compliance

- The restricted-state list lives in `state_rules` and is read on every
  submission, so compliance changes it with an `UPDATE` and no deploy. Nothing
  in the browser decides restriction — a compliance rule enforced in client code
  is one devtools console away from being ignored.
- A `state_rules` lookup failure is treated as **restricted**. When the question
  is "may we pass this person's details to a buyer", the safe direction to fail
  in is obvious.
- Restricted leads have contact fields stripped in `api/drain.ts` **and** again
  in the n8n Code node before Airtable, and the Airtable `Restricted` table has
  no contact columns at all — not a hidden view, the fields do not exist.
- Restricted leads reach the Conversions API with Limited Data Use set.
- The TCPA consent artifact stores the exact consent **text**, its version,
  timestamp, IP and user agent. A version number nobody can resolve back to
  wording is not a consent record, and in legal lead gen the consent record is
  the product.
- Operational events and logs carry ids and status only. A redactor strips
  forbidden keys at any depth from everything logged — a convention every call
  site must remember is not a control. `api/_lib/log.test.ts` proves it,
  including the realistic accident of logging a whole lead row.
- `/ops` returns no personal data, and its key travels in a header; a query
  parameter would put it in browser history, referrers and access logs.

---

## Design

The audience is people over 40 who cannot work, arriving from a Meta ad on a
phone, frequently with a vision, motor or cognitive impairment. So: 4rem touch
targets, 1.125rem minimum body text, one question per screen, focus moved to
each new question for screen readers, and errors carried by shape as well as
colour. Every size is in `rem` under a `100%` root, so an enlarged device font
actually enlarges the page — a px scale under a `100%` root is a comment, not a
behaviour.

For this audience legibility and completion rate are the same variable, so this
is a conversion argument rather than a compliance checkbox.

Six questions: age, state, work, duration, work history (the SSA 20-of-40-
quarters rule), doctor. State is asked **second** because availability is the
first thing worth knowing — behind an explicit "Check availability" confirm, so
an unsupported state ends early instead of after four more taps, and a network
failure says "cannot check right now" rather than inventing a verdict. A "No" on
any knockout question exits to a distinct non-match screen that captures no
contact details and fires no conversion event, but does offer an explicit,
separately-consented follow-up opt-in that routes to nurture — never to sales,
and never as the qualified conversion.

---

## Verifying it yourself

```bash
npm run verify      # typecheck + 56 unit tests + build
npm run test:e2e    # 32 Playwright tests against the deployed funnel
```

The end-to-end suite drives the **live** site and writes real rows;
[`tests/README.md`](./tests/README.md) covers configuration and what each suite
proves. The two assertions worth reading are the `eid` check in
`tests/tags.spec.ts` — the deduplication contract, on the wire — and the
outbox/delivered payload checks in `tests/funnel.meta-capi.spec.ts`.

```bash
curl -s https://lexhive.vercel.app/api/health   # three delivery signals + the server's pixel id
```

**Running locally**

```bash
npm install
npx vercel login    # once
npm run dev         # vercel dev: the React app and the api/ functions together
```

Copy `.env.example` → `.env.local`. Only `VITE_`-prefixed variables reach the
browser; anything carrying a credential stays server-side.

---

## Where the reasoning lives

| File | What it is |
|---|---|
| [`SUBMISSION.md`](./SUBMISSION.md) | Assumptions, trade-offs, known gaps |
| [`docs/gtm-setup.md`](./docs/gtm-setup.md) | The container, tag by tag — including the field deduplication depends on |
| [`docs/setup-airtable-n8n.md`](./docs/setup-airtable-n8n.md) | Wiring the automation layer and proving it end to end |
| [`PRODUCTION.md`](./PRODUCTION.md) | What this needs before real ad spend, in priority order |
| This file | How the system works and why |

---

## What I would build next

1. Rate limiting and bot protection on `/api/lead`, and real auth on `/ops`.
   Both are in `PRODUCTION.md` in priority order.
2. Dataset Quality API polling into `/ops`, alerting when match rate drops.
3. A server-side GTM container, so the Pixel is proxied first-party rather than
   loaded from `connect.facebook.net`.
4. Step-level drop-off reporting from the partial rows — the number that
   actually tells you which funnel variant to keep.
5. A replay-all control on `/ops`, to recover a whole outage window at once.
