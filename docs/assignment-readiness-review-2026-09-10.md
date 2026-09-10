# LexHive take-home: project setup and submission readiness

Reviewed 10 September 2026 against the supplied assignment and the linked job description. This report makes no application or deployment changes.

## Verdict

The architecture is a strong fit for this assignment and for the actual role. The job description explicitly names React/Vite, Vercel, Supabase, n8n, Airtable, GTM, Meta CAPI, restricted-state routing, monitoring, and funnel experiments. The project covers most of that stack directly. Its durable lead store, delivery outbox, and replay surface are relevant engineering choices.

The submission is not ready to present as fully verified. The main remaining work is correcting delivery and tracking edge cases, aligning the deployed and published versions, and packaging convincing evidence. More features or a large redesign would be lower priority for a 6–8 hour assignment.

Source brief: the assignment provided in the conversation. Role context: [Growth Automation Engineer job description](https://docs.google.com/document/d/1AYolRDogopGivLjPOZhAcZLUlN0WUB_6sTuFZfQgEOM/edit). The reference funnel's entry page was also inspected; it supplies service context, branding, and privacy/terms links that the current project entry page lacks. The reference's age question differs from this project's age range, so describe that as a deliberate screening assumption rather than an exact reproduction.

## What was verified

- `npm run verify` passed: TypeScript check, all 38 unit tests, and Vite production build.
- The public React entry page loads at `https://lexhive.vercel.app/qualification-v1`.
- The repository is publicly accessible at `https://github.com/h2automations/lexhive-funnel`.
- The live `/api/health` page returned Vercel `404: NOT_FOUND`, including after the user's request to try again. Its local source exists; that does not establish deployed availability.
- Local Git reports `main...origin/main [ahead 3]`. The commits are `354668a`, `48d18d5`, and `8147f75`; they include documentation changes and the GTM export. The public repository page still displays the older state.
- The Airtable base link redirects a logged-out visitor to sign-in. This establishes an access dependency, not whether the intended reviewer has an invitation.
- Local exports exist for lead routing, scheduled draining, delivery monitoring, and GTM. Supabase schema and verification SQL are present. Airtable field definitions and setup instructions are documented.
- `SUBMISSION.md` contains approximately 1,018 whitespace-delimited words. `docs/LOOM.md` is a script; no actual Loom recording URL was found in the submission documentation searched.
- An offline capture of `sendMetaEvent()` confirmed that `test_event_code` is sent inside `data[0]` and that no AbortSignal is provided. No real Meta request was made.

Not reverified: authenticated Meta Events Manager diagnostics, current EMQ, n8n activation/execution history, live Airtable record delivery, Sentry configuration, or a complete live submission. The existing browser suite writes to production and can send real downstream events; it was not run as part of this read-only readiness review. Historical observations in `docs/verification-2026-09-09.md` remain historical evidence, not fresh verification.

## Assignment coverage

| Requirement | Assessment | What makes it reviewable |
|---|---|---|
| Similar React funnel | Implemented; live entry verified. UX needs the changes in the separate UX review. | Show the actual mobile flow, including a non-match path. |
| Capture a lead | Implemented through `/api/lead`, validation, Supabase, and partial saves. | One complete test submission with a stable lead ID and persisted contact data in a controlled demo environment. |
| High-quality Meta events | Normalization, hashing, identifiers, attribution, stable event ID, and GTM mapping exist. Test-mode placement is incorrect; final platform dedup evidence is incomplete. | Capture the browser event, server event, matching event names and IDs, Test Events result, and dated matching diagnostics. |
| Automation to structured database | n8n → Airtable mappings/upserts and export templates exist. Supabase provides the durable store. | Show an execution that completes only after the Airtable upsert, then the corresponding record. Provide access or a sanitized export. |
| Visible and recoverable failures | Outbox, retry states, dead letters, health logic, logs, and replay exist. There are correctness gaps and the live health endpoint is missing. | Demonstrate one controlled failure, visible failed state, retry/replay, and successful recovery without duplicate records. |
| Live link | Available. | Verify the exact submitted version and relevant routes. |
| GitHub repository | Public, but behind local work. | Publish the intended final commit; ensure exports are included. |
| Automation/database links or exports | Local workflow exports and database setup exist; reviewer access needs checking. | Supply workflow files and Airtable schema/sample-data export or a restricted-access demo base. |
| Loom, maximum five minutes | Script present; recording link not found. | Record the working system and attach a playable link. |
| Written note, maximum one page | Existing note is too long for a practical one-page handoff. | Reduce to roughly 350–450 words and verify its rendered length. Keep longer explanations in README/docs. |

## Findings to address before submission

### 1. Correct the Meta test request envelope — high priority

`api/_lib/meta-capi.ts:180` places the test code on an individual event. The request body at line 200 then contains only `data` and `access_token`. Meta's official SDK sends `test_event_code` beside `data` at the request level. This can prevent the intended Test Events workflow from operating correctly; do not rely on the current setting as test/live isolation.

Fix the request shape and add a payload assertion for it. Expected structure:

```json
{
  "data": [{ "event_name": "Lead", "event_id": "one-stable-id" }],
  "test_event_code": "TEST_CODE",
  "access_token": "SERVER_ONLY_TOKEN"
}
```

Reference: [Meta's official EventRequest implementation](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/serverside/event-request.js), which serializes these fields together in `execute()`.

### 2. Bound Meta delivery and the drain's work — high priority

`api/_lib/meta-capi.ts:194` calls `fetch` without a timeout. `api/drain.ts:274` processes a claimed batch serially. A hung Meta request can prevent later Airtable deliveries in that batch from being attempted. The four-second timeout in `/api/lead` bounds its call to the drain; it does not impose a timeout on the drain's own outbound Meta call.

Give the full Meta exchange, including reading its response, a deadline. Bound work per drain invocation to the configured deployment duration. A ten-row batch of sequential ten-second requests can already exceed the n8n caller's thirty-second timeout. Use a smaller bounded batch or limited concurrency with an explicit overall deadline. Verify one slow destination does not starve the other.

### 3. Make the retry cap survive worker crashes — high priority

`supabase/schema.sql:178` resets all expired `delivering` rows to `pending`. The claim query then increments attempts without excluding rows at `max_attempts`. A worker that repeatedly crashes before recording its result can therefore be reclaimed beyond the six-attempt budget.

Dead-letter exhausted expired leases during reclamation and require remaining attempts before claiming. Test repeated crash/reclaim cycles against the SQL function. Distinguish at-least-once delivery from exactly-once claims: a destination can accept a request before the worker crashes, so destination idempotency remains necessary.

### 4. Protect completed submissions from later writes — high priority

`api/lead.ts:241` and `:255` build `status` and `submitted_at` from every incoming request. The update at `:315` does not check the existing lifecycle state. Reusing a submission ID with a partial request can turn a completed lead into a partial lead and clear its conversion timestamp. Repeating a completion changes the timestamp despite retaining its event ID. The browser's save queue helps in the normal session, but is not a server-side invariant.

Make finalization atomic and monotonic: completed leads retain their original event ID, conversion timestamp, consent artifact, and finalized answers. Return the existing completion for an identical retry; use a separate explicit correction process if edits are supported. Test duplicate completion, stale partial-after-complete, and racing initial saves. A deterministic ID plus a unique index does not make a racing insert automatically return success; the conflict needs handling.

### 5. Do not report successful delivery when bookkeeping fails — high priority

The success/failure/dead updates in `api/drain.ts` ignore Supabase's returned `error`. The worker can log a delivery as succeeded and stamp a successful heartbeat while its row remains leased. `loadLead()` also ignores query errors and treats missing returned data as a permanent `lead_not_found`, turning a transient database read failure into a dead letter.

Check persistence results, distinguish a missing lead from a failed read, and report unresolved bookkeeping. Use conditional updates tied to the active lease/attempt so an expired worker cannot overwrite a newer worker's result. The ops read endpoint likewise ignores query errors and can return misleading empty/default values; surface an unavailable state instead.

### 6. Fix tests that give false confidence — high priority

- `tests/funnel.meta-capi.spec.ts:111` queries `status='dead_lettered'`; the application writes `dead`. That assertion can pass while actual dead letters exist.
- The test named “advanced matching fields present in payload” checks only `event_id`, `event_name`, and `request_id` in the outbox. Those are metadata, not the outgoing CAPI `user_data` fields. Rename it and add actual outbound payload coverage; keep platform match-quality evidence separate.
- Its wait helper considers zero pending rows sufficient, which also includes failed, dead, delivering, or absent rows. Wait for both expected destinations and their intended final states for the specific test lead.
- Global “zero pending/dead” assertions depend on unrelated production traffic. Scope them to the current test cohort.
- The database helpers interpolate credentials into shell command strings, then log caught command errors. Use argument arrays and a process environment instead, and avoid logging command text with credentials.

The passing 38 unit tests are useful, but they do not cover these handler, SQL, and live configuration boundaries.

### 7. Deploy and prove the monitor — submission blocker

The endpoint promised in the Loom is currently a 404. Align the production deployment with the intended commit, apply needed schema changes, and verify a real healthy report before recording. Confirm recurring drain executions independently of submissions, because inline delivery can conceal a stopped scheduler.

In the workflow exports, Supabase `Load config` does not enable `alwaysOutputData`. If an empty result emits no items, downstream “Require config”/assessment code never runs. Account explicitly for missing configuration and test it. The monitor's HTTP node accepts error status codes, but network errors can still stop execution before its custom Notify branch; configure an error path that reaches the alert channel.

A separate workflow on the same n8n instance detects a stopped drain workflow, but does not independently detect the entire n8n host going down. Treat an external uptime check as a production follow-up. A failed execution visible in n8n is not equivalent to a delivered notification.

## Claims and setup details to correct

These corrections matter because the assignment explicitly expects the candidate to explain the code.

- **Event ID:** the current browser generates `submissionId`; the server validates and persists it as the authoritative lead/event ID. Do not say the server mints it. A stable client-generated ID can be valid; consistency and idempotent handling are what matter.
- **Response timing:** the request does not end immediately when the lead commits. It performs additional writes/event flushing and awaits the bounded inline drain request. Explain the actual order and its latency trade-off.
- **Exactly once:** `SKIP LOCKED` prevents simultaneous ordinary claims; it does not eliminate duplicate deliveries after a crash or an expired lease. Describe at-least-once attempts with Meta event deduplication and Airtable upserts.
- **Dedup evidence:** the September 9 verification note says Meta's deduplication panel was still parsing. Matching IDs on the wire are useful evidence, but do not describe the final platform panel as verified until it has been observed. EMQ 8.0 is a historical recorded observation, not a current guarantee or proof of deduplication.
- **Restricted-state list:** the twelve-state seed is an assumption in the submission, not a rule supplied by the assignment. Keep configurable routing as a demonstration, but do not present this list as validated legal guidance. Obtain actual partner criteria before real acquisition.
- **Privacy:** generic names and omission of raw answers do not prove that health-related information is absent. A qualified-only event is selected using medical answers. Avoid absolute “no health signal” claims; describe the actual data flow and unresolved platform restrictions. Likewise, key-based log redaction does not sanitize every arbitrary string or exception message.
- **Consent:** the API accepts consent text/version/time from the client. Store a server-known disclosure version/text and server receipt time if claiming an authoritative consent artifact; preserve the user's affirmative action separately.
- **Lead quality counts:** `lead_counts()` counts qualified disposition even for partial records. A partially answered visitor is not a completed MQL. Separate completed qualified leads from in-progress rule status before using this dashboard for conversion reporting.
- **Documentation drift:** README, setup guide, GTM notes, verification history, and Loom differ on test counts, Clarity, export availability, event-ID origin, scheduler status, and whether the API drains inline. Use one current status table with dated evidence. Keep old incident notes clearly historical.
- **Repository hygiene:** remove tracked temporary lock artifacts in a cleanup change; keep credentials out of exports. The known real `.env.local` and `.env.e2e` files are untracked/ignored, while examples are tracked. This was not a complete historical secret scan.
- **Reproducibility:** document one fresh-clone path using `npm ci`, environment examples, Supabase schema/config, n8n credential bindings, Airtable fields, and `npm run dev`. `package.json` currently maps `dev` to `vercel dev`; contrary documentation should be removed. Add a minimal CI job for the offline verification command if time permits.

## How to spend the remaining assignment effort

1. Correct the Meta envelope, timeouts, lifecycle/retry handling, and misleading assertions. Fix the work-history qualification defect from the UX review.
2. Publish the intended repository version and deploy it. Verify health, scheduler activity, configuration bindings, and a full test lead across the chain.
3. Capture one traceable evidence bundle: lead ID, browser/server event names and IDs, platform result, n8n execution, Airtable row, and a controlled failure/recovery. Use sanitized evidence and an isolated demo/staging flow for fault injection.
4. Make the highest-impact UX corrections: service context, state selection, honest non-match results, and operations action visibility. Avoid a broad visual rebuild before the core evidence works.
5. Package the handoff: live URL, exact commit/repository, workflow exports, database access/export, actual Loom, and a genuinely one-page note.

Keep the current stack. Redtrack, a server-side GTM container, sophisticated experiment assignment, LLM workflows, custom CRM features, and more dashboards are not required by this take-home. Explain them as possible extensions only where relevant. Do not represent route labels as implemented A/B experiments: currently different variant paths render the same UI.

## Suggested five-minute demonstration

| Time | Show |
|---|---|
| 0:00–0:30 | The offer, architecture, and why a durable store precedes delivery. |
| 0:30–1:20 | One qualified mobile flow and successful capture. |
| 1:20–2:20 | The matching browser/server Lead IDs, Meta Test Events outcome, and normalized matching fields. |
| 2:20–3:05 | The matching n8n execution and Airtable record. |
| 3:05–4:15 | One controlled failure, visible status, replay/retry, and recovered delivery. |
| 4:15–4:40 | Restricted routing with contact fields omitted and the correct destination. |
| 4:40–5:00 | Two actual trade-offs and the highest-priority remaining limitation. |

Use prepared tabs and a rehearsed, isolated failure demonstration. The existing script's instruction to age a live heartbeat is not necessary for a convincing recording and does not prove that an actual failed delivery can be replayed. Showing the recovery mechanism directly addresses the assignment better than describing it.

The short written note should spend its limited space on the actual architecture, stable IDs, at-least-once delivery, assumptions, verified evidence, and known limitations. Move incident history and long justifications to linked documentation. Avoid absolute claims such as “impossible,” “never loses a lead,” or “every conversion counted twice” where the implementation and platform behavior are more conditional.
