# LexHive — Growth Automation take-home

A Social Security disability qualification funnel with server-side conversion
tracking and a delivery layer built so that a downstream outage cannot lose a
lead.

**Live funnel:** https://lexhive.vercel.app/qualification-v1
**Ops view:** https://lexhive.vercel.app/ops
**Project (Vercel):** lexhive-funnel

---

## Status

**Deployed to Vercel production** at `https://lexhive.vercel.app`.
The build passes (`npm run build`), typechecks clean (`tsc --noEmit`), and both
`/qualification-v1` and `/ops` return 200.

| Status | Item |
|---|---|
| ✅ | Vercel production deployment linked to project `lexhive-funnel` |
| ✅ | Meta Pixel installed — dataset `27653864700958179` |
| ✅ | `VITE_META_PIXEL_ID` set as a Vercel production env var |
| ✅ | **Supabase configured** — `schema.sql` applied (leads, state_rules, delivery_outbox, claim_outbox_batch, lead_counts, outbox_health, RLS all live) |
| ✅ | Server-side env vars on Vercel: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `META_PIXEL_ID`, `META_API_VERSION`, `DRAIN_SECRET`, `OPS_KEY`, `PUBLIC_BASE_URL` |
| ✅ | Drain ESM import fixed (`./_lib/meta-capi.js`) — was `ERR_MODULE_NOT_FOUND` |
| ✅ | End-to-end verified: partial save → complete submit → outbox enqueue → drain claim → retryable backoff → `/ops` health summary |
| ⬜ | `META_CAPI_ACCESS_TOKEN` — needed for server-side Meta events to deliver |
| ⬜ | n8n workflows imported/activated + `N8N_WEBHOOK_URL` set for Airtable delivery |
| ⬜ | Airtable base + Slack webhook configured |
| ⬜ | Meta Test Events verification (dedup + match quality) |

**To finish:** add `META_CAPI_ACCESS_TOKEN` on Vercel for server-side Meta
events, then import and activate the two workflows in `n8n/` and set
`N8N_WEBHOOK_URL`. Airtable and Slack are configured in n8n per the setup
guide.

---

## Architecture

```
Browser (React + Vite, Vercel)
   │  attribution captured on landing, progress saved on every step
   ▼
POST /api/lead
   │  1. insert or update ONE lead row      ← durability boundary; returns here
   │  2. on completion, enqueue delivery_outbox rows
   ▼
POST /api/drain  (triggered by n8n Schedule, every 60s)
   │  claim_outbox_batch() — FOR UPDATE SKIP LOCKED
   ├──► Meta Conversions API      dedup via shared event_id
   └──► n8n webhook ──► Airtable  upsert on Lead ID
             │
             └─ failure ──► exponential backoff ──► dead-letter ──► Slack
```

The one decision everything else follows from: **the request is finished the
moment Postgres commits.** Meta and Airtable are deliveries, not dependencies.

---

## Tracking quality

**Pixel initialisation.** The page uses Meta's canonical `fbq` stub, which is
load-bearing rather than boilerplate: `fbevents.js` replays whatever is sitting
in `fbq.queue` when it finishes loading. A stub without that array accepts every
call and drops it, so `init`, `PageView` and `Lead` all disappear and the
dataset reports no activity while the pixel ID is provably present in the HTML.

**Deduplication.** `/api/lead` generates the `event_id`, stores it on the lead
row, and returns it. The browser fires `fbq('track','Lead',{},{eventID})` with
that exact value while the drain worker sends the same one to the Conversions
API. Making the server the source of truth means a mismatch is structurally
impossible rather than merely unlikely — the common pattern of minting the ID
client-side and hoping the server echoes it breaks silently on any retry.

**Identifiers sent.** `em`, `ph`, `fn`, `ln`, `st`, `zp`, `country`, and
`external_id`, each normalized before hashing; `client_ip_address`,
`client_user_agent`, `fbp`, and `fbc` unhashed. `st` is the two-letter code
lowercased and `zp` is the five-digit ZIP asked for on the contact step —
Meta's normalization rules are exact, and a hash of `"New York"` matches
nothing while failing with no error. `ct` (city) is **not** sent: the funnel
does not collect a city, and filling the field with the state to have something
there costs match quality rather than adding it.

**`fbc` reconstruction.** When `_fbc` is absent but `fbclid` is in the URL, the
value is rebuilt as `fb.<subdomain_index>.<first_seen_ms>.<fbclid>`, using the
session's first touch rather than the current time, and deriving the index from
the hostname rather than hardcoding it — Meta writes `fb.2.…` on
`lexhive.vercel.app`, and a constant `1` there is a near-miss that costs match
quality without ever raising an error. This is the largest match-quality gain
available in the funnel and is routinely missed, because the cookie only exists
after the Pixel script loads — visitors who bounce, block scripts, or submit
quickly never get one.

**Attribution timing.** `fbclid`, UTMs, and referrer are captured on the first
pageview and persisted. Capturing at submit is too late: the query string is
gone after the first route change. Cookie identifiers are re-read at submit,
since the Pixel often writes `_fbp` after first paint.

**Step events.** Funnel steps fire as `trackCustom('FunnelStep', …)`. They are
not standard events, and sending them through `track` has Meta discard them as
unrecognised names.

**`external_id`.** A first-party session UUID is set in the Pixel's advanced
matching and sent hashed in `user_data`. It survives cookie loss mid-funnel and
costs nothing.

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
| Dead-letter + Slack alert | Bounded failure that a human is told about |
| `/ops` replay | Recovery is a button, not a database query |

`attempts` is incremented in exactly one place — `claim_outbox_batch`. The
worker reads it and never adds to it. Incrementing in both spends two attempts
per failure and skips every other rung of the backoff ladder, which turns a
six-attempt budget into three and is invisible until an outage runs long.

**Progress saves.** Every answer updates the same lead row: the first save
returns an id, and each later one sends it back. An abandoned funnel leaves one
recoverable record with the step it stopped at, rather than one row per
question inflating every count on `/ops` by a factor of six.

---

## Privacy and compliance

- The restricted-state list lives in the `state_rules` table and is read on
  every submission, so compliance changes it with an `UPDATE` and no deploy.
  Nothing in the browser decides restriction — the client is told the
  disposition by the server and renders accordingly.
- A `state_rules` lookup failure is treated as **restricted**. When the question
  is "may we pass this person's details to a buyer", the safe direction to fail
  in is obvious.
- Restricted leads have contact fields dropped in `api/drain.ts` **and** again
  in the n8n Code node before Airtable. Not an Airtable view: a view is a
  display filter, and the data would still be in the base.
- Restricted leads are sent to the Conversions API with Limited Data Use set.
- Slack alerts carry `lead_id` and an ops link. Never a name, phone, or email.
- `/ops` returns no personal data at all, and its key travels in a header — a
  query parameter would put it in browser history, referrers, and access logs.
- The TCPA consent artifact stores the exact consent **text**, its version,
  timestamp, IP, and user agent. A version number nobody can resolve back to
  wording is not a consent record, and in legal lead gen the consent record is
  the product.
- `outbox_health` is declared `security_invoker`, so the view obeys the
  caller's permissions instead of its owner's and cannot be read past RLS with
  the anon key.

---

## Design

The audience is people over 40 who cannot work, arriving from a Meta ad on a
phone, frequently with a vision, motor, or cognitive impairment. So the funnel
uses 4rem targets, 1.125rem minimum body text, one question per screen, focus
moved to each new question for screen reader users, and error states carried by
shape as well as colour.

Every size is in `rem`. `html { font-size: 100% }` preserves the user's own font
setting, but that only reaches the page if everything downstream is relative to
it — a px-based scale under a `100%` root is a comment, not a behaviour.

This is a conversion argument, not a taste one: for this audience, legibility
and completion rate are the same variable.

---

## Trade-offs and assumptions

**Assumed** the funnel is a US Social Security disability offer, since the
reference funnel is SSDI. Phone normalization assumes a US country code and
drops anything that isn't ten digits rather than guessing.

**Contact capture placement.** I kept contact capture at the end, matching the
reference funnel. Moving it one step earlier would enrich every subsequent event
and capture identifiers on abandoned sessions, at some cost to completion rate.
That is an A/B test, not an assumption — the variant plumbing is already in
place to run it.

**ZIP on the contact step.** One extra field, and it is a Meta match key that
nobody questions on a benefits form. City would need a second field for less
return, so it is not asked and not sent.

**n8n Schedule instead of Vercel Cron.** Vercel's Hobby plan caps cron at once
per day, which is useless for a 60-second retry loop. Using an n8n Schedule node
turned out to be the better design anyway: the automation layer visibly
orchestrates recovery instead of a hidden platform cron.

**No router library.** Two routes do not justify the dependency.

**Rate limiting.** `/api/lead` validates and bounds its input (variant pattern,
answers size cap, field truncation) but is not rate limited — that needs a
shared store, and the honest place for it is Vercel's WAF or an Upstash counter
rather than something improvised in the handler.

**Event Match Quality score.** EMQ needs live traffic over several days, so no
real score exists yet. What is demonstrated is the input side: which identifiers
are sent, correctly normalized, with browser/server deduplication confirmed in
Test Events. In production I would poll the Dataset Quality API for match rate
and alert when it drops below threshold.

**Test event code.** `META_TEST_EVENT_CODE` routes events to the Test Events tab
during evaluation. It must be **unset** in production or events never reach live
reporting. Deduplication and match quality behave identically either way.

---

## Observability

Three layers, because they answer different questions: structured JSON logs to a
drain (`api/_lib/log.ts`), Sentry for exceptions (`api/_lib/sentry.ts`), and a
`app_events` table in Postgres for the domain events `/ops` reports on
(`api/_lib/events.ts`).

No personal data reaches any of them. That is enforced by a redactor that strips
forbidden keys at any depth from everything logged, not by a convention every
call site has to remember — `api/_lib/log.test.ts` proves it, including the
realistic accident of logging a whole lead row.

`request_id` flows from the browser response header, through the log lines, onto
the outbox row, and into the drain's logs, so a delivery that succeeds three
retries later is still traceable to the submission that created it.

**[PRODUCTION.md](./PRODUCTION.md)** covers what else this needs before it
carries real ad spend, in the order I would do it — rate limiting and bot
protection on the lead endpoint, real auth on `/ops`, a dead-man's switch on the
drain, migrations, staging, CI, and a retention policy — plus what to alert on
and at what threshold.

---

## Running the checks

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test, via esbuild
npm run verify      # all of the above plus the build
```

---

## What I would build next

1. Dataset Quality API polling into the `/ops` view, with a Slack alert when
   match rate drops.
2. Server-side GTM container so the Pixel is proxied first-party rather than
   loaded from `connect.facebook.net`.
3. Step-level drop-off reporting from the partial rows, which is the number that
   actually tells you which funnel variant to keep.
4. A replay-all control on `/ops` for recovering a whole outage window at once.

---

## Running locally

```bash
npm install        # installs dependencies (incl. vercel CLI as dev dep)
npx vercel login   # once
npx vercel dev     # serves the React app AND the api/ functions together
```

`npm run dev` will NOT run the `api/` folder — `npm run dev` = plain Vite, so
`api/lead` and `api/drain` would 404. Use `vercel dev`.

Copy `.env.example` → `.env.local` and fill in the blanks. Only `VITE_`-prefixed
variables reach the browser; anything containing credentials (Supabase key, Meta
access token, webhook secrets) must stay server-side.
