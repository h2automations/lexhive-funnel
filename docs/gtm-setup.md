# GTM container setup — `GTM-P34XGVL3`

The container loads from code — `loadGtm()` in `src/main.tsx` injects the GTM
snippet for every route except `/ops`, which must never fire marketing or
analytics tags. (An `index.html` snippet cannot see the SPA route, so the guard
lives in code.) Every browser tag is configured in the container rather than in
code: the app pushes to the dataLayer, the container decides who hears about
it, and adding a vendor is a container change rather than a deploy.

**Export the finished container** (Admin → Export Container) and commit the JSON
to `gtm/` — same reason the n8n workflows are exported. Configuration that only
exists in someone's account is configuration nobody can review.

---

## There is only one page

Worth settling before you build a single trigger: **this is a single-page app.**
`App.tsx` reads `window.location.pathname` once at mount and nothing ever pushes
history. The URL is identical on question one and on the thank-you screen.

So a Page View trigger fires **once per session**, no History Change event ever
fires, and a trigger like `Page Path equals /qualification-v1/step-2` matches
nothing, because that page does not exist. Funnel progress is carried entirely
by the custom events below.

| Path | Renders | Track? |
|---|---|---|
| `/qualification-v1` | The funnel — canonical entry | Yes |
| `/qualification-v2`, `-v3`, … | Same funnel, different variant | Yes |
| `/` | The funnel; variant defaults to `qualification-v1` | Yes |
| **`/ops`** | Internal delivery surface | **No — block** |

Anything that isn't `/ops` renders the funnel: Vercel rewrites every non-`/api/`
path to `index.html`, and `App.tsx` treats the path as the variant name. So the
only page condition you need is the `/ops` exclusion.

If you want per-variant reporting, match `Page Path` with the RegEx
`^/qualification-v\d+$` — the variant is the path, which is what makes an A/B
test a URL change rather than a deploy.

**Do not push virtual pageviews for the steps.** It would inflate session
pageview counts and make bounce rate meaningless, to describe something
`funnel_step` already describes exactly.

---

## The dataLayer contract

Three events, all pushed from `src/lib/datalayer.ts`. Nothing else is published.

| Event | Fired when | Variables |
|---|---|---|
| `funnel_ready` | Funnel mounts, session id exists | `variant`, `external_id` |
| `funnel_step` | Each question answered | `step_number`, `variant` |
| `lead_submitted` | Submission succeeds | `event_id`, `variant`, `disposition` |

No name, email, phone, ZIP or answer text is ever pushed. Anything on the
dataLayer is readable by every tag in the container and by anyone with the
console open, so treat it as published to all vendors at once.

`funnel_step` carries an **ordinal**, not the question's semantic id. Meta
flagged this domain as *"associated with medical conditions"*; a variable
reading `question: "doctor"` on a disability questionnaire feeds exactly that
classification. The ordinal gives an identical drop-off curve.

---

## 1. Variables

Create these Data Layer Variables (Variables → New → Data Layer Variable), name
matching the dataLayer key exactly:

- `DLV - event_id`
- `DLV - external_id`
- `DLV - variant`
- `DLV - disposition`
- `DLV - step_number`

## 2. Triggers

Custom Event triggers, one per dataLayer event:

- `CE - funnel_ready` → event name `funnel_ready`
- `CE - funnel_step` → event name `funnel_step`
- `CE - lead_submitted` → event name `lead_submitted`

## 3. Meta Pixel — the part that matters

Use the community **Facebook Pixel** template (Templates → Search Gallery).

**Base tag / PageView**

| Field | Value |
|---|---|
| Pixel ID | `3238075189714579` |
| Object Property Name / advanced matching | `external_id` = `{{DLV - external_id}}` |
| Trigger | **`CE - funnel_ready`** |

> **Check the ID against Events Manager before you paste it.** There are two
> datasets in this account named `lexhive-assignment`. `3238075189714579`
> (business: SEER Business) is the live one — it holds every Lead, arriving
> from both the Pixel and the Conversions API, which is what Events Manager
> labels *Integration: Multiple*. `27653864700958179` sits under a different ad
> account, has never received a Lead, and is the one this document used to
> name. Pointing the container at it would send browser conversions somewhere
> the server never looks, with no error anywhere — the events keep sending, the
> tags keep going green, and deduplication just stops. `/api/health` reports
> `meta_pixel_id` and `tests/tags.spec.ts` asserts the browser matches it, so
> the mistake is now catchable, but it is far cheaper not to make.

> Trigger this on `funnel_ready`, **not All Pages.** GTM loads before React
> mounts, so an All Pages trigger fires before `external_id` exists and
> initialises advanced matching with nothing — silently, on the first pageview
> of every session, which is the hardest kind of gap to spot in a match-quality
> report.

**Lead tag**

| Field | Value |
|---|---|
| Event Name | `Lead` |
| **Event ID** | **`{{DLV - event_id}}`** ← the whole design rests on this |
| Trigger | `CE - lead_submitted` |

`/api/lead` mints `event_id`, stores it on the lead row, returns it to the
browser, and the drain sends the same id to the Conversions API. Meta collapses
the two into one conversion **only if this field is mapped.**

If it isn't, nothing looks wrong: no error, no failed tag, a green tick in
Preview mode — and every conversion is counted twice, which silently corrupts
every optimisation decision downstream. Moving tags into a container traded
code-enforced correctness for a form field, and this is the field.

**Optional: `FunnelStep`** as a custom event on `CE - funnel_step`, with
`step_number`. Useful for drop-off audiences; it is not a standard event, so
send it as a custom one.

## 4. GA4

| Tag | Type | Trigger | Parameters |
|---|---|---|---|
| GA4 Config | Google Tag, `G-Z5K86SX1QY` | Initialization – All Pages | — |
| `funnel_step` | GA4 Event | `CE - funnel_step` | `step_number`, `variant` |
| `generate_lead` | GA4 Event | `CE - lead_submitted` | `variant`, `disposition` |

`generate_lead` is GA4's recommended name, so it works with the built-in
reports rather than needing a custom conversion. **Send no `value`** — a lead's
worth depends on the buyer, and an invented number quietly corrupts every ROAS
report built on it.

## 5. Microsoft Clarity — *not currently installed*

Set up and later removed; kept here so it can be reintroduced without rework.

Custom HTML tag with the Clarity snippet for project `yfgq1rnly4`, on
Initialization – All Pages.

Then, in the **Clarity dashboard**, set masking to **Strict**. The contact form
carries `data-clarity-mask` in the markup, but that only covers what we
remembered to mark; Strict covers what we didn't. This is a disability
questionnaire collecting a name, a phone number and a TCPA consent record —
worth two layers.

## 6. Exclude `/ops`

Add a **blocking trigger** on all tags: Page Path **contains** `/ops`.

`/ops` is an internal delivery surface with a replay button. Session-recording
it serves nobody, and counting your own 2am debugging as marketing traffic
distorts the numbers you make decisions with.

---

## Verify before publishing

1. **Preview mode** → open the funnel → step through it.
2. `funnel_ready` fires once, and the Meta base tag fires **after** it with
   `external_id` populated.
3. `funnel_step` fires once per question, with an ordinal and no question id.
4. On submit, `lead_submitted` fires, and in the Meta Lead tag's detail panel
   **Event ID is populated** — not empty, not `undefined`.
5. Events Manager → **Test events** → the `Lead` shows **Browser and Server,
   deduplicated**. That screenshot is the proof the whole tracking design works.
6. Load `/ops` and confirm **no tags fire**.

Step 4 is the one to actually look at. Everything else fails loudly.
