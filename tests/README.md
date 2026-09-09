# End-to-end tests

The unit tests in `api/_lib/*.test.ts` cover the three places a bug is silent
in isolation — the compliance decision, CAPI normalisation, the log redactor.
These cover the places a bug is silent *across a boundary*, where nothing
throws and the only symptom is a number that is wrong later.

| File | What it holds |
|---|---|
| `support/funnel.ts` | The shared vocabulary: question wording, option labels, contact fields, funnel-driving primitives. One place to change when the copy changes. |
| `funnel.e2e.spec.ts` | The six journeys: load, qualified, disqualified, restricted, ops, accessibility. |
| `resilience.spec.ts` | What happens when a save 500s, the compliance lookup never answers, an ad blocker is on, or someone taps Back. |
| `tags.spec.ts` | GTM container `GTM-P34XGVL3` on the wire — advanced matching, the `eid` deduplication field, what fires on `/ops`. |
| `legibility.spec.ts` | Target size, the rem scale, autofill tokens, phone layout. |

## Running

```bash
npm install
npx playwright install chromium

npm run test:e2e                                  # everything, against production
npm run test:e2e -- tests/tags.spec.ts            # one suite
npm run test:e2e:headed                           # watch it drive
npx playwright test --ui                          # time-travel debugger
npx playwright test --debug -g "event_id"         # step through one test
```

Configuration comes from the environment, falling back to `.env.e2e` (copy
`.env.e2e.example`). The real environment always wins.

- `BASE_URL` — defaults to `https://lexhive.vercel.app`.
- `OPS_KEY` — unset means the authenticated `/ops` assertions self-skip.
- `E2E_VARIANT` — the funnel path to drive; defaults to `qualification-v1`.
- `E2E_*` — override the generated contact details.

No credential is ever written into a test file, and no contact detail is ever
printed into an assertion message: CI logs outlive the run.

## These tests write real rows

Against production, a full run creates roughly four partial lead rows and two
completed leads, which means two real Meta events and two real Airtable
records. That is deliberate — a tag test against a stubbed endpoint only
proves the stub — but it is worth knowing before running it during a demo.

Completed test leads carry a `playwright+` email local part:

```sql
delete from public.leads where email like 'playwright+%';
```

Partial rows carry no contact details, so nothing distinguishes them from a
real abandoned session. When that matters — before a demo, or when the
drop-off numbers on `/ops` are about to be shown to someone — run against a
separate variant. The path is the variant, so this is the whole mechanism:

```bash
E2E_VARIANT=qualification-e2e npm run test:e2e
```

```sql
delete from public.leads where variant = 'qualification-e2e';
```

The trade-off is that `tags.spec.ts` then drives a path the container's
triggers may not match, so it will skip. Run it separately on the default
variant when the container is what you are checking.

To avoid production entirely, point `BASE_URL` at a `vercel dev` instance
backed by a staging Supabase project.

## The two assertions that matter most

**`funnel.e2e.spec.ts` → `application_submitted` carries the server's
`event_id`.** That is the deduplication invariant at the source.

**`tags.spec.ts` → the browser `Lead` event carries the same id as `eid`.**
The same invariant one layer out, on the wire, and the only automated check
that the GTM tag's Event ID field is actually mapped. If it is not, nothing
errors, Preview mode shows a green tick, and every conversion is counted
twice.

Both are cheap to write and neither would ever fail loudly on its own. That is
the point of testing them.

## Notes for whoever debugs a red run

`tags.spec.ts` skips rather than fails when a tag never loads at all — an
unpublished container or a blocked network is a configuration state, not a
regression. It fails only when the tag fires and carries the wrong thing.

Tests run serially in one worker (`playwright.config.ts`) because they share
one production database; two funnels in flight at once would interleave their
partial saves.

Answering a question a second time after Back pushes a second `funnel_step`
for that ordinal. That is intended — the event counts answers, not unique
screens — and it is why the `funnel_step` count is asserted only on paths that
never go back.
