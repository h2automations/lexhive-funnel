# End-to-end verification — 9 September 2026

A live run against production (`https://lexhive.vercel.app`), driven through a
real browser, with every result cross-checked in Meta Events Manager, Airtable
and n8n. Three dispositions were exercised: qualified, restricted,
disqualified.

This is not the Playwright suite. The suite asserts the same invariants and is
in `tests/`; it has to be run from a machine that can reach the deployment.
This document records what was observed on the production system.

---

## Verdict

The tracking design works. The three things that were genuinely uncertain —
deduplication, compliance routing, and whether anything reaches Airtable — are
all confirmed correct on the live system. What is broken is the *scheduler*,
not the pipeline: the n8n drain has never once succeeded, and delivery has been
carried entirely by the API's inline self-heal.

---

## 1. The deduplication invariant — confirmed on the wire

The qualified Texas submission produced:

| Layer | `event_id` |
|---|---|
| Server response (`POST /api/lead`, `status: complete`) | `60b3115b-49a3-4eab-8350-86985e5a5595` |
| `dataLayer` → `application_submitted` | `60b3115b-49a3-4eab-8350-86985e5a5595` |
| `dataLayer` → `qualified_lead` | `60b3115b-49a3-4eab-8350-86985e5a5595` |
| Browser Pixel request `facebook.com/tr?ev=Lead` | `eid=60b3115b-49a3-4eab-8350-86985e5a5595` |

The GTM tag's Event ID field is mapped to `{{DLV - event_id}}` and the value on
the wire is the id the server persisted and sends to the Conversions API. This
is the one link in the design that fails silently and shows a green tick in
Preview mode, and it is correct.

Advanced matching is present on every browser event:
`ud[external_id]=a73ff89e7ec10b8c6900643a425a88050dbb0eff5d53c11feaceb2aab219b344`.

**Meta Events Manager, Lead event, today:**

- Event Match Quality **8.0 / 10** — it was 0.0 before the container fix
- Total browser events received: **23**
- Total server events received: **47**
- Integration: Multiple (Pixel + Conversions API)
- Event deduplication: *"Still Parsing Your Data — we've noticed you're sending
  Conversions API events"*

Meta confirms it is receiving both halves. The deduplication report itself is
still computing; check it before recording the Loom, because that panel is the
screenshot worth having.

## 2. Compliance routing — confirmed end to end

**Restricted (New York).** The server returned `disposition: restricted` from
the state partial save, before any contact field was rendered. The contact step
showed the restricted heading, the restricted consent wording, and a form
containing exactly one input: the consent checkbox. No name, email, phone or
ZIP field exists on that path — they are not hidden, they are not built.
`application_submitted` fired; `qualified_lead` did **not**, so no Meta
optimisation event was sent for a lead that cannot be contacted.

The row landed in the Airtable **Restricted** table (row 27,
`f65a30f9-fee5-4dca-91b2-…`, state `NY`, consent `v1.1`). That table has no
contact columns at all — six fields, none of them personal. The separation is
structural rather than a hidden view.

**Disqualified (knockout on the work question).** Server returned
`disposition: disqualified`. `application_submitted` fired; `qualified_lead`
did not. The record reached the Airtable **Leads** table fully populated —
`recgXxYLTfsuKuGAs`, every mapped column filled.

**Qualified (Texas).** All seven `funnel_step` ordinals fired exactly once,
1 through 7, carrying no question ids and no answer text. Completed
successfully; contact details reached Airtable; the Lead pixel event carried
the dedup id above.

## 3. Accessibility and privacy spot-checks, live

- Focus moves to the new `h1` on every screen transition (verified via
  `document.activeElement` after answering)
- Answer targets measure exactly **64px** — the 4rem intent holds in production
- The state question renders 51 options, all at full target height
- `form[data-clarity-mask="true"]` present on the contact step
- All five contact fields carry their correct `autocomplete` tokens
  (`given-name`, `family-name`, `email`, `tel`, `postal-code`)
- No contact value appeared in any request to a third-party host

---

## What needs fixing

### P0 — the drain has never run

`{{ $env.PUBLIC_BASE_URL }}` inside an n8n node does not throw on this
instance; it resolves to the literal string `[ERROR: access to env vars
denied]`. The workflow has been POSTing to a URL built from that error text
every 60 seconds since it was activated.

Nothing was lost, because `/api/lead` runs a bounded drain sweep inline before
responding — that self-heal is why Airtable and the CAPI have data at all. But
the scheduler that is supposed to retry a *failed* delivery has never executed
once. A Meta outage during a submission would leave that row waiting for a
worker that does not run.

Fixed in `49d58bf`. To apply:

1. Run the `app_config` block at the bottom of `supabase/schema.sql`, then seed
   the row with the real base URL and the `DRAIN_SECRET` already set on Vercel.
2. In n8n, create a **Supabase** credential named
   `LexHive Supabase (service role)`.
3. Re-import `n8n/lexhive-outbox-drain.json` and activate it.

The workflow is now Schedule → Load config → Require config → Call drain.
`Require config` throws a named error if the row is missing, so a
misconfiguration is a failed execution rather than a workflow that quietly does
nothing — which is the failure that just happened.

### P1 — two tags stopped firing about six hours ago

Events Manager shows `PageView` and `Submit application` both "last received 6
hours ago", while `QualificationStarted`, `FunnelStep` and `Lead` are current.
The live run confirms it: across a full funnel, the browser sent
`QualificationStarted`, seven `FunnelStep`s and one `Lead` — no `PageView`, no
`SubmitApplication`.

Most likely the `Submit application` tag still triggers on the old
`lead_submitted` custom event, which the app renamed to `application_submitted`
when the qualified/all split was introduced. Worth deciding deliberately rather
than by accident: given the Business Tools restriction on this domain, fewer
event types is arguably the right posture — but it should be a choice.

### P1 — Microsoft Clarity is not loading

Zero requests to `clarity.ms` on a full page load. Either both Clarity tags
were removed when the duplicate was cleaned up, or the remaining one is
unpublished or paused.

### P2 — the submit button sits on "Submitting…" for 6–16 seconds

The completion request runs the inline drain sweep — Meta CAPI plus the n8n
webhook, each with a 10-second timeout — *before* it responds. That is the
right trade for durability, but it puts the wait on the one screen where
abandonment is most expensive, with no progress feedback beyond a disabled
button. Once the n8n drain is actually running, the inline sweep can be reduced
to a fire-and-forget trigger, or the response can be returned before the sweep.

### P2 — 47 server Lead events against 23 browser Lead events

`api/lead.ts` enqueues a `meta_capi` outbox row only when
`disposition === 'qualified'`, and the browser `Lead` tag fires only on
`qualified_lead`. The two counts should track each other. Two innocent
explanations — the browser tag was misconfigured earlier today while the server
kept sending, or a delivery Meta actually received timed out and was retried
with the same `event_id`. Worth one look at the `meta_capi` rows on `/ops`
before the interview, because "server sends more conversions than the browser"
is exactly the question an evaluator asks.

### P2 — GA4 collect returning 503

Two `POST https://www.google-analytics.com/g/collect` requests returned **503**
during the run (`page_view` and `scroll`). Worth confirming in GA4 Realtime
that hits are actually landing.

### P3 — housekeeping before submission

- The disqualified completion screen says *"A benefits specialist may contact
  you."* The done screen branches only on `restricted`, so a knocked-out lead
  is told someone will call. In legal lead gen that is worth a third branch.
- `_fbc` in the testing browser holds `fb.2.…TESTCLICK123.…` — a synthetic
  click id from earlier testing, now attached to every event from that browser.
- The Airtable **Restricted** table's rows 1–15 are Airtable's sample data
  (`LD1001`, variant `A`/`B`/`C`, 2024 dates). The **Leads** table has a block
  of blank rows at the top. Both should be cleared before the base is shared.
- Meta's diagnostics recommend sending Click ID (`fbc`) on `Lead` — the CAPI
  client already supports it; worth checking how many stored leads have one.

---

## Running the Playwright suite

```bash
npm install
npx playwright install chromium

npm run test:e2e:watch     # headed, one worker, 450ms between actions
npm run test:e2e           # headless
```

`E2E_SLOW_MO` controls the delay. Point elsewhere with `BASE_URL`, and use
`E2E_VARIANT=qualification-e2e` to keep generated rows separable — see
`tests/README.md`.
