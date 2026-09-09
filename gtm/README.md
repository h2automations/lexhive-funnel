# GTM container export

`GTM-P34XGVL3.json` is the full export of container **GTM-P34XGVL3**
(`www.lexhive.vercel.app`). Configuration that exists only in someone's Google
account is configuration nobody can review — the same reason `n8n/` holds
workflow exports rather than screenshots.

Re-export after any container change: **Admin → Export Container**, pick the
published version, and overwrite this file. Keeping the filename stable means
the next export lands as a diff rather than a second file.

## What's in it

Eight tags, five triggers, five variables. The app pushes four dataLayer events
and the container decides who hears about each one.

| Tag | Fires on | dataLayer event |
|---|---|---|
| Facebook Pixel – PageView | `CE - Qualification V1 Ready` | `funnel_ready` |
| Facebook Pixel – Qualification Started | `CE - Qualification V1 Ready` | `funnel_ready` |
| Facebook Pixel – Funnel Step | `CE - Funnel Step` | `funnel_step` |
| Facebook Pixel – Qualified Lead | `CE - Qualified Lead` | `qualified_lead` |
| Ga4 - Config | Initialization, excluding `/ops` | — |
| GA4 – funnel_step | `CE - Funnel Step` | `funnel_step` |
| GA4 – application_submitted | `CE - Application Submitted` | `application_submitted` |
| GA4 – generate_lead | `CE - Qualified Lead` | `qualified_lead` |

Meta hears about four events; GA4 hears about three. The asymmetry is the
point — see below.

## The two lines worth reading

**Deduplication.** Search the file for `"eventId"`. It appears exactly once, on
`Facebook Pixel – Qualified Lead`, mapped to `{{DLV - event_id}}`:

```json
{ "type": "TEMPLATE", "key": "eventId", "value": "{{DLV - event_id}}" }
```

That is the whole deduplication contract. `/api/lead` mints and persists that
id, returns it, the browser fires with it, and the drain sends the same one to
the Conversions API. If this line is missing, nothing errors, Preview shows a
green tick, and every conversion is counted twice. It appears once and only
once because `Lead` is the only event with a server counterpart — the others
have nothing to deduplicate against.

**Advanced matching.** All four Meta tags carry `{{DLV - external_id}}`.
`PageView` fires on `funnel_ready` rather than All Pages for exactly this
reason: GTM loads before React mounts, so a page-level trigger would initialise
the Pixel before an `external_id` exists and send the first event of every
session with nothing to match on.

## Why `application_submitted` goes to GA4 and not to Meta

The app pushes `application_submitted` on every completion and `qualified_lead`
only when the lead is actionable. The gap between them — people who finish the
form and are knocked out — is a real product metric: it says whether the
qualification questions are too strict, and it is how a broken knockout rule
would show up.

It is measured in GA4, with `disposition` as an event parameter so the count
splits into qualified, restricted and disqualified. It is deliberately **not** a
second Meta conversion event: the server only sends `Lead`, and only for
qualified leads, so a browser-only `SubmitApplication` would have no CAPI half,
nothing to deduplicate against, and would add a second conversion signal from a
domain Meta has classified as health-related. One conversion event, because
there is only one worth optimising toward.

`disposition`, `variant` and `step_number` have to be registered as GA4 custom
dimensions (Admin → Custom definitions) or the parameters are recorded and
invisible.

## Not in here

No Microsoft Clarity tag. It was set up and later removed;
`docs/gtm-setup.md` §5 still describes the configuration if it is reintroduced.
The contact form keeps `data-clarity-mask="true"` in the markup regardless,
which costs nothing and means the mask is already in place if any session
recorder is ever added.
