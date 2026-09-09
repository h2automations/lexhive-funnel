# Database

Three files, run in this order.

| File | Committed? | Run |
|---|---|---|
| `schema.sql` | yes | every deploy — it is idempotent |
| `seed-app-config.example.sql` | yes (the example) | copy, fill in, run once |
| `verify.sql` | yes | after both, and any time you want the truth |

## 1. `schema.sql`

Safe to re-run against a live database. Every statement is `if not exists`,
`create or replace`, `drop … if exists` first, or `on conflict do nothing`; the
two `state_rules` seeds will not touch existing rows, and the `app_config`
constraints are added through DO blocks because `create table if not exists`
will not add a constraint to a table that already exists.

That safety has a cost worth naming: a successful run tells you nothing about
whether anything changed. That is what `verify.sql` is for.

## 2. `seed-app-config.example.sql`

The one row `schema.sql` deliberately does not create, because it holds a
secret and `schema.sql` is in the repository.

```bash
cp supabase/seed-app-config.example.sql supabase/seed-app-config.sql
# fill in drain_secret with the DRAIN_SECRET value from Vercel, then run it
```

`supabase/seed-app-config.sql` is gitignored. `drain_secret` must match the
Vercel variable byte for byte — `/api/drain` compares them with
`timingSafeEqual`, so a stray trailing space is a 401 that looks exactly like a
rotated secret nobody updated. The table's check constraint rejects surrounding
whitespace for that reason, and rejects a base URL with a trailing slash
because that builds `https://host//api/drain`.

## 3. `verify.sql`

Read-only. Nine checks; every row should read `ok`.

```
check_name                      status        detail
tables                          ok            app_config, app_events, delivery_outbox, leads, state_rules
leads columns                   ok            consent_given, consent_text, gender, submission_id
functions                       ok            claim_outbox_batch, delivery_metrics, lead_counts, reconcile_missing_outbox
outbox_health view              ok            the /ops surface reads this
outbox_health security_invoker  ok            anon must not read past RLS through the view
row level security              ok            app_config=true, app_events=true, …
state_rules coverage            ok            51 states, 12 restricted
app_config seeded               ok            https://lexhive.vercel.app, secret 32 chars
outbox backlog                  ok            141 succeeded, 0 waiting, 0 dead
```

`state_rules coverage` is the one people skip past. Every state needs an
explicit row: `/api/lead` treats "no rule for this state" as restricted, so a
missing row does not throw — it silently routes an entire state away from the
sales base.

`outbox backlog` is not schema. It is here because it answers the question the
schema cannot: **is the drain actually running?** Rows sitting in `pending` or
`failed` with a `next_attempt_at` more than fifteen minutes in the past mean
nothing is claiming them.
