# LexHive take-home — notes

**Funnel** https://lexhive.vercel.app/qualification-v1 · **Ops** https://lexhive.vercel.app/ops
**Repo** https://github.com/h2automations/lexhive-funnel · **Automation** `n8n/*.json` · **Tags** `gtm/*.json` · **Database** https://airtable.com/appGH8RYEydLFlyNA

## The decision everything follows from

The request is finished the moment Postgres commits. Meta and Airtable are
*deliveries*, not dependencies — `/api/lead` writes the lead and enqueues an
outbox row per destination; a worker drains it on a 60-second n8n schedule. No
downstream outage can lose a lead.

One deliberate exception: a completed submission also runs a **bounded
4-second drain sweep before responding**. Vercel can freeze an invocation the
moment it returns, so work started after the response may never run — the
choice is between the person waiting a moment and the delivery being silently
dropped. The person waits, capped by an AbortController, with the n8n schedule
as the real backstop.

## Assumptions

US Social Security disability, since the reference funnel is SSDI — phone
normalization adds the US country code, digits only as Meta expects, and drops
anything invalid rather than guessing. The restricted-state list is the twelve
states commonly restricted for legal lead gen; it lives in a `state_rules`
table read on every submission, so compliance changes it with an `UPDATE` and
no deploy. "Structured database" is Airtable via n8n, per the brief's stack.

The screen order and wording are a deliberate screening model, not an exact
reproduction of the reference. State is asked second (a native picker behind an
explicit "Check availability" confirm) so an unsupported state exits early, and
work history is asked as the SSA 20-of-40-quarters rule. The reference's age
range differs from this funnel's 18–64, so claim submissions should treat the
six questions as targeting assumptions to confirm against the real offer, not
as the brief's gospel.

## Trade-offs

**Deduplication is server-authoritative.** The browser proposes a submission
UUID; `/api/lead` validates it, persists it as `event_id`, and returns the
stored value. The Pixel fires with what came back, not with what it sent, and
the drain sends the same stored value to the CAPI — so a person who submits
twice is handed the first attempt's id and still produces one conversion.
`/api/health` also reports `meta_pixel_id`: both halves can carry the right
event id and still never meet if the container and `META_PIXEL_ID` name
different pixels, which fails with no error at all. `tests/tags.spec.ts`
asserts they match.

**All browser tags live in GTM**, not in the code. The app publishes four
dataLayer events (`funnel_ready`, `funnel_step`, the conversion
`application_submitted`, and the optimization-gated `qualified_lead`) and the
container fires Meta and GA4 from them, so a
new vendor is a container change rather than a deploy. The trade: dedup now depends on the Pixel tag's Event ID field being
mapped to `{{DLV - event_id}}`, and if it isn't, nothing errors and every
conversion is counted twice. The container export belongs in `gtm/` alongside the
n8n workflows for that reason: the one field the dedup depends on should be
reviewable in a diff, not buried in a UI.

**`event_time` is the conversion moment, not the delivery attempt.** The drain
retries with backoff to a 32-minute ceiling over six attempts, so stamping
`Date.now()` at delivery would report a retried lead in the wrong hour and,
after a long outage, push it outside the attribution window entirely — the
retry machinery quietly corrupting the data it exists to protect. The lead row
already knows when the person actually converted, so that is what is sent.

**Match keys are chosen, not maximised.** `ct` is not sent — the funnel has no
city, and filling it with the state costs match quality rather than adding it.
ZIP is asked as an optional field (one tap, a real key); gender is not asked at
all — the UX review removed it because it was a match key, not a knockout
question, and the schema column it left behind is now dropped. Contact is
phone-led: name and phone required, email and ZIP optional. "Prefer not to say"
mapped to a value the CAPI client drops rather than hashes, so opting out sent
Meta nothing rather than a placeholder (that option itself is gone with
gender).

**Health signals stay out of the ad platforms.** Meta flagged this domain under
its Business Tool Terms as *"associated with medical conditions"* — the real
constraint in this vertical. So browser events carry a step **ordinal** and
nothing more: not the answer, and not the question's semantic id, since
`question: "doctor"` feeds that classification itself. Same drop-off curve.
Semantic ids stay in `app_events`, our database rather than an ad platform's,
and the contact form carries `data-clarity-mask` so any session recorder is
masked at the markup rather than by a dashboard setting.

**Restriction is decided server-side.** The browser is told its disposition; it
never decides. A compliance rule enforced in client code is a compliance rule
one devtools console away from being ignored.

**Disqualified ≠ muted — it is a distinct, opt-in relationship.** A knockout
exit navigates to a choice screen: "No thanks" (nothing further stored) or
"Keep me updated", which captures minimal contact (first name, email, phone)
plus a *separate* consent — `disqualified_nurture_v1` — and routes to the
nurture pipeline as a `Nurture` row in Airtable and a custom `NurtureOptIn`
event in Meta. It never fires the `Lead` conversion, and a disqualified person
without the opt-in never becomes a lead at all: the server strips their contact
entirely and enqueues **no** delivery rows. Restricted stays the hardest rule —
contact is stripped server-side regardless of what the browser claims, and no
outbox row is created. The whole policy lives in
`api/_lib/follow-up.ts` so the acceptance criteria are unit-testable and the
lead `lead_type` (`Sales | Nurture | None`) is what the n8n workflow branches
on, never a recalculated disposition.

## Extra, beyond the brief

- **Partial saves** — every answer updates one lead row, so an abandoned funnel
  leaves a recoverable record and a per-step drop-off point.
- **`/ops`** — delivery health, p50/p95 latency, a replay button. A delivery
  only an engineer with database access can replay isn't recoverable, it's
  logged.
- **Observability** — structured JSON logs, Sentry, an `app_events` table. No
  personal data reaches any of them, enforced by a tested redactor rather than
  by every call site remembering.
- **Accessibility as a conversion argument** — 4rem targets, focus moved for
  screen readers, a rem scale so an enlarged device font actually enlarges the
  page. For people over 40 who can't work, usually on a phone, often with a
  vision impairment, legibility and completion rate are the same variable.
- **40 unit tests** over the four places a bug here is silent rather than loud —
  the compliance decision, CAPI normalization, the log redactor, the
  delivery-health thresholds — plus a Playwright suite checking the same
  invariants from the outside, including `eid` on the wire.

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
