# Wiring up the automation layer

The three workflows in `n8n/` are exports. This is what turns them into something
a reviewer can click. Roughly 20 minutes.

Field names below are **exact** — the n8n nodes map to them by name, so a
mismatch fails at the Airtable node rather than anywhere useful.

---

## 1. Airtable base

Create a base called **LexHive Leads** with two tables.

### Table: `Leads`

| Field | Type | Notes |
|---|---|---|
| `Lead ID` | Single line text | **Primary field.** The upsert matches on it |
| `Variant` | Single line text | `qualification-v1` — the A/B dimension |
| `First Name` | Single line text | |
| `Last Name` | Single line text | |
| `Email` | Email | |
| `Phone` | Phone number | |
| `State` | Single line text | Two-letter code |
| `Gender` | Single select | `m`, `f`, `undisclosed` |
| `ZIP` | Single line text | Text, not Number — leading zeros matter |
| `Disposition` | Single select | `qualified`, `restricted`, `disqualified` |
| `UTM Source` | Single line text | |
| `UTM Campaign` | Single line text | |
| `Has FBC` | Checkbox | Whether a click id was captured |
| `Consent Version` | Single line text | |
| `Consent At` | Date (include time) | |
| `Submitted At` | Date (include time) | |

### Table: `Restricted`

Contact fields are **absent by design** — they are stripped in `api/drain.ts`
and again in the n8n Code node, so they never enter the base at all. An Airtable
view that hides columns would not do this: a view is a display filter, and the
data would still be there.

| Field | Type |
|---|---|
| `Lead ID` | Single line text (**primary**) |
| `Variant` | Single line text |
| `State` | Single line text |
| `Disposition` | Single select |
| `Consent Version` | Single line text |
| `Submitted At` | Date (include time) |

Then: **Airtable → Builder hub → Personal access tokens**. Create one with
`data.records:read`, `data.records:write` and `schema.bases:read`, scoped to
this base only. Copy the base ID from the URL (`airtable.com/appXXXXXXXX/…`).

---

## 2. n8n

**Import.** Workflows → Import from File, once for each file in `n8n/` — there
are three: lead routing, the outbox drain, and error alerts.

**Error alerts.** `lexhive-error-alerts.json` is an Error Trigger workflow that
posts to Slack when any other workflow fails. Set `SLACK_WEBHOOK_URL` in n8n's
environment, then open each of the other two workflows → Settings → **Error
Workflow** → select it. Without this, an Airtable node failing *after* the
webhook has already responded 200 leaves the outbox recording a success that
never happened — the one gap the retry machinery cannot see.

**Credentials.** On both Airtable nodes, add the personal access token. Set the
`AIRTABLE_BASE_ID` environment variable in n8n to the base ID, or replace the
`{{ $env.AIRTABLE_BASE_ID }}` expression with the literal value.

**Lead routing workflow.** Activate it, then copy the production webhook URL
from the Webhook node — that value is `N8N_WEBHOOK_URL` in the next step. Check
the flow reads Webhook → Restricted state? → *(true)* Strip contact fields →
Airtable Restricted, *(false)* Flatten payload → Airtable Leads.

**Outbox drain workflow.** Set two environment variables in n8n:

- `PUBLIC_BASE_URL` = `https://lexhive.vercel.app`
- `DRAIN_SECRET` = the same value as on Vercel

Activate it. **Nothing is delivered until this workflow is running** — it is the
only thing that calls `/api/drain`, so without it no lead reaches Meta or
Airtable, and no error is raised anywhere. That is the failure mode
`PRODUCTION.md` argues for a dead-man's switch against.

---

## 3. Vercel

Add to Project → Settings → Environment Variables (Production), then redeploy —
environment changes only take effect on the next build:

| Variable | Value |
|---|---|
| `N8N_WEBHOOK_URL` | The production webhook URL from above |
| `META_CAPI_ACCESS_TOKEN` | Events Manager → Settings → Conversions API → Generate access token |
| `SLACK_WEBHOOK_URL` | Optional; dead-letter alerts |
| `SENTRY_DSN` | Optional; error tracking |

Also re-run `supabase/schema.sql` if you haven't since the observability commit
— it adds `app_events`, `delivery_metrics()` and a new `claim_outbox_batch`
signature.

---

## 4. Prove it end to end

1. Open Events Manager → **Test events**, enter the funnel URL, click Test
   Events.
2. Complete the funnel in the tab it opens, using a Texas address.
3. **Test Events** should show `PageView`, `FunnelStep`, and a `Lead` marked as
   **deduplicated** across Browser and Server. That last one is the screenshot
   worth keeping — it is the single best piece of evidence in the submission,
   and it is the thing the brief says they care most about.
4. **Airtable** → the row appears in `Leads` within a minute.
5. **`/ops`** → both destinations show `succeeded`, with p50/p95 timings.
6. Repeat with **New York**. The funnel should stop asking for contact details,
   and the row should land in `Restricted` with no name, email or phone.

Step 6 is the compliance demonstration. Worth recording.

### If something doesn't arrive

`/ops` names the destination, the attempt count and the last error. Common ones:

| Error | Cause |
|---|---|
| `n8n_webhook_url_not_configured` | `N8N_WEBHOOK_URL` unset on Vercel, or no redeploy since |
| `http_401` on `meta_capi` | Bad or missing `META_CAPI_ACCESS_TOKEN` |
| `http_422` on `n8n_airtable` | An Airtable field name doesn't match the table above |
| Nothing moves at all | The drain workflow isn't active in n8n |
