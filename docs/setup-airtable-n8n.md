# Wiring up the automation layer

The three workflows in `n8n/` are exports. This is what turns them into something
a reviewer can click. Roughly 20 minutes.

Field names below are **exact** — the n8n nodes map to them by name, so a
mismatch fails at the Airtable node rather than anywhere useful.

---

## 1. Airtable base

Create a base called **LexHive Leads** with three tables.

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

### Table: `Nurture`

Disqualified opt-ins — people who did not qualify but explicitly asked to be
contacted about *other* programs. Contact is separated from the `Leads` table by
intent, not by a flag: the two are different relationships, and mixing them
makes the sales team's base look like everyone who ever filled the form in.

| Field | Type |
|---|---|
| `Lead ID` | Single line text (**primary**) |
| `Variant` | Single line text |
| `First Name` | Single line text |
| `Email` | Email |
| `Phone` | Phone number |
| `State` | Single line text |
| `Disposition` | Single select |
| `Consent Version` | Single line text |
| `Consent At` | Date (include time) |
| `Submitted At` | Date (include time) |
| `Follow-Up Type` | Single line text — `disqualified_nurture` |
| `Contact Capture Reason` | Single line text — `disqualified_optional_nurture` |
| `Qualification Reason` | Single line text — e.g. `insufficient_work_history` |

Then: **Airtable → Builder hub → Personal access tokens**. Create one with
`data.records:read`, `data.records:write` and `schema.bases:read`, scoped to
this base only. Copy the base ID from the URL (`airtable.com/appXXXXXXXX/…`).

---

## 2. n8n

**Import.** Workflows → Import from File for the two workflows in `n8n/`: lead
routing and the outbox drain. The lead-routing webhook responds only after its
Airtable node finishes, so a failure returns non-2xx and the outbox retries it.

**Credentials.** On both Airtable nodes, add the personal access token. The
authenticated webhook payload carries `airtable_base_id`, and both Airtable
nodes read it using `{{ $json.airtable_base_id }}`. Keep the token itself only
in n8n credentials; it must never be included in the webhook body.

**Lead routing workflow.** Activate it, then copy the production webhook URL
from the Webhook node — that value is `N8N_WEBHOOK_URL` in the next step. Check
the flow reads Webhook → Restricted state? → *(true)* Strip contact fields →
Airtable Restricted, *(false)* Flatten payload → Nurture or Sales? →
*(Sales)* Airtable Leads, *(Nurture)* Airtable Nurture. The branch key is
`lead_type`, set by `api/drain.ts` — the workflow branches on the payload the
server computed, and never recalculates a disposition.

**Outbox drain workflow.** Its config comes from Supabase, not from n8n
environment variables. This instance runs with `N8N_BLOCK_ENV_ACCESS_IN_NODE`
enabled, so `{{ $env.PUBLIC_BASE_URL }}` inside a node resolves to the string
`[ERROR: access to env vars denied]` — the node does not throw, it POSTs to a
URL made of that error text and fails on every schedule tick.

1. Run `supabase/schema.sql`, then seed the single config row from
   `supabase/seed-app-config.example.sql` (copy it to
   `supabase/seed-app-config.sql`, which is gitignored, and fill in the
   secret). `supabase/verify.sql` confirms it took. In full:

   ```sql
   insert into public.app_config (id, public_base_url, drain_secret)
   values (1, 'https://lexhive.vercel.app', '<the same DRAIN_SECRET set in Vercel>')
   on conflict (id) do update
     set public_base_url = excluded.public_base_url,
         drain_secret    = excluded.drain_secret,
         updated_at      = now();
   ```

   RLS is on with no policy granted, so only the service role can read it.

2. In n8n, create a **Supabase** credential named
   `LexHive Supabase (service role)` — host
   `https://nmfjwytnwxsspigjlwgr.supabase.co`,
   service-role key. That credential is the only secret involved, and it lives
   in n8n's encrypted credential store, which is where a secret belongs.

3. Import `n8n/lexhive-outbox-drain.json`. The flow is
   Schedule → Load config → Require config → Call drain. `Require config`
   throws a named error when the row is missing, so a misconfiguration shows up
   as a failed execution rather than a workflow that quietly does nothing.

**Delivery monitor workflow.** Import `n8n/lexhive-delivery-monitor.json` and
activate it. It polls `/api/health` every five minutes and is deliberately
independent of the drain — a monitor that lives inside the workflow it watches
goes down with it. Optionally give it somewhere to shout:

```sql
update public.app_config
set alert_webhook_url = 'https://hooks.slack.com/services/…'
where id = 1;
```

With that unset the monitor still fails its own execution when delivery is
degraded, which puts the outage in n8n's execution list either way.

Activate the drain. **Nothing is delivered until that workflow is running** — it is the
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
| `N8N_INTERNAL_SECRET` | A long random value; use the same value in n8n's `LexHive Internal Secret` header-auth credential (`x-internal-secret`) |
| `AIRTABLE_BASE_ID` | The `app...` identifier copied from the LexHive Leads base URL; included in the authenticated n8n payload |
| `META_CAPI_ACCESS_TOKEN` | Events Manager → Settings → Conversions API → Generate access token |
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
| `n8n_internal_secret_not_configured` | `N8N_INTERNAL_SECRET` is missing on Vercel |
| `airtable_base_id_not_configured` | `AIRTABLE_BASE_ID` is missing on Vercel |
| `http_401` on `meta_capi` | Bad or missing `META_CAPI_ACCESS_TOKEN` |
| `http_422` on `n8n_airtable` | An Airtable field name doesn't match the table above |
| Nothing moves at all | The drain workflow isn't active in n8n |
