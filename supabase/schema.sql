-- LexHive funnel schema
-- Run the whole file in the Supabase SQL Editor. It is idempotent — safe to
-- re-run over an existing database. Should finish with
-- "Success. No rows returned."

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------
-- leads
-- ----------------------------------------------------------------------
create table if not exists public.leads (
  id            uuid primary key default gen_random_uuid(),
  variant       text not null default 'qualification-v1',
  status        text not null default 'partial',        -- partial | complete
  disposition   text not null default 'qualified',      -- qualified | restricted | disqualified
  answers       jsonb not null default '{}'::jsonb,
  first_name    text,
  last_name     text,
  email         text,
  phone         text,
  state         text,
  zip           text,
  consent_version text,
  consent_at    timestamptz,
  submitted_at  timestamptz,
  first_seen_at timestamptz,
  fbclid        text,
  fbc           text,
  fbp           text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_content   text,
  utm_term      text,
  referrer      text,
  external_id   text,
  event_id      uuid,
  client_ip     text,
  user_agent    text,
  dedupe_key    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The consent artifact. A version number nobody can resolve back to wording is
-- not a consent record, so the exact text is stored with it.
alter table public.leads add column if not exists consent_text  text;
alter table public.leads add column if not exists consent_given boolean;

create index if not exists leads_status_idx  on public.leads (status);
create index if not exists leads_disp_idx    on public.leads (disposition);
create index if not exists leads_dedupe_idx  on public.leads (dedupe_key) where dedupe_key is not null;
create index if not exists leads_created_idx on public.leads (created_at desc);

-- ----------------------------------------------------------------------
-- state_rules — the restricted-state list. This table is the source of
-- truth and is read on every submission, so compliance changes the list
-- with an UPDATE rather than a deploy.
-- ----------------------------------------------------------------------
create table if not exists public.state_rules (
  id          serial primary key,
  state_code  text not null unique,
  restricted  boolean not null default false
);

insert into public.state_rules (state_code, restricted) values
  ('AR', true), ('CT', true), ('MA', true), ('MN', true),
  ('MS', true), ('MT', true), ('NV', true), ('NJ', true),
  ('NY', true), ('NC', true), ('TN', true), ('VT', true)
on conflict (state_code) do nothing;

-- Every other state, explicitly unrestricted. These rows are required, not
-- decorative: /api/lead treats "no rule for this state" as restricted, so
-- without them a Texas lead would be blocked from the sales base. Failing
-- closed is the right default for an unknown value and a broken funnel for a
-- known one, which is why every state gets an explicit rule.
insert into public.state_rules (state_code, restricted) values
  ('AL', false), ('AK', false), ('AZ', false), ('CA', false), ('CO', false),
  ('DE', false), ('DC', false), ('FL', false), ('GA', false), ('HI', false),
  ('ID', false), ('IL', false), ('IN', false), ('IA', false), ('KS', false),
  ('KY', false), ('LA', false), ('ME', false), ('MD', false), ('MI', false),
  ('MO', false), ('NE', false), ('NH', false), ('NM', false), ('ND', false),
  ('OH', false), ('OK', false), ('OR', false), ('PA', false), ('RI', false),
  ('SC', false), ('SD', false), ('TX', false), ('UT', false), ('VA', false),
  ('WA', false), ('WV', false), ('WI', false), ('WY', false)
on conflict (state_code) do nothing;

-- ----------------------------------------------------------------------
-- delivery_outbox — one row per destination per lead
-- ----------------------------------------------------------------------
create table if not exists public.delivery_outbox (
  id              bigserial primary key,
  lead_id         uuid not null references public.leads (id) on delete cascade,
  destination     text not null,                     -- meta_capi | n8n_airtable
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'pending',   -- pending|delivering|failed|dead|succeeded
  attempts        int not null default 0,
  max_attempts    int not null default 6,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists outbox_claim_idx on public.delivery_outbox
  (status, next_attempt_at) where status in ('pending', 'failed');

create index if not exists outbox_lead_idx on public.delivery_outbox (lead_id);

-- One delivery per destination per lead, so a double submit cannot enqueue
-- the same event twice.
create unique index if not exists outbox_lead_destination_uniq
  on public.delivery_outbox (lead_id, destination);

-- ----------------------------------------------------------------------
-- claim_outbox_batch — atomic claim that never double-delivers
--
-- Uses FOR UPDATE SKIP LOCKED so overlapping drain runs each claim a disjoint
-- set. `attempts` is incremented HERE and only here, so a worker that dies
-- mid-flight burns an attempt rather than looping forever. Rows left in
-- 'delivering' self-release after a 5-minute lease.
-- ----------------------------------------------------------------------
create or replace function public.claim_outbox_batch(batch_size int default 10)
returns table (
  id bigint,
  lead_id uuid,
  destination text,
  payload jsonb
) language plpgsql as $$
declare
  v_lease interval := interval '5 minutes';
begin
  -- Release anything whose lease has expired (worker crashed mid-flight).
  update public.delivery_outbox
     set status = 'pending',
         updated_at = now()
   where status = 'delivering'
     and updated_at < now() - v_lease;

  -- Claim the next batch atomically.
  return query
    with claimed as (
      select o.id
        from public.delivery_outbox o
       where o.status in ('pending', 'failed')
         and o.next_attempt_at <= now()
       order by o.next_attempt_at asc
       limit batch_size
       for update of o skip locked
    )
    update public.delivery_outbox o
       set status = 'delivering',
           attempts = o.attempts + 1,
           updated_at = now()
      from claimed c
     where o.id = c.id
     returning o.id, o.lead_id, o.destination, o.payload;
end; $$;

-- ----------------------------------------------------------------------
-- lead_counts — funnel totals aggregated in the database rather than by
-- pulling every row into a serverless function to call .filter() on it.
-- ----------------------------------------------------------------------
create or replace function public.lead_counts()
returns table (
  partial bigint,
  complete bigint,
  qualified bigint,
  restricted bigint,
  disqualified bigint
) language sql stable as $$
  select
    count(*) filter (where status = 'partial')            as partial,
    count(*) filter (where status = 'complete')           as complete,
    count(*) filter (where disposition = 'qualified')     as qualified,
    count(*) filter (where disposition = 'restricted')    as restricted,
    count(*) filter (where disposition = 'disqualified')  as disqualified
  from public.leads;
$$;

-- ----------------------------------------------------------------------
-- outbox_health — view used by the ops surface
-- ----------------------------------------------------------------------
create or replace view public.outbox_health as
select
  destination,
  case
    when count(*) filter (where status in ('failed', 'dead')) > 0 then 'degraded'
    when count(*) filter (where status = 'pending') > 0           then 'backlogged'
    else 'healthy'
  end as status,
  count(*) as rows
from public.delivery_outbox
group by destination;

-- A view runs with its owner's privileges by default, which would let the anon
-- key read straight past the RLS below. security_invoker makes the view obey
-- the caller's permissions instead.
alter view public.outbox_health set (security_invoker = on);

-- ----------------------------------------------------------------------
-- Row Level Security: deny all. service_role bypasses RLS anyway; this is
-- belt-and-braces so nobody reading this accidentally uses the anon key
-- server-side and finds it works.
-- ----------------------------------------------------------------------
alter table public.leads           enable row level security;
alter table public.delivery_outbox enable row level security;
alter table public.state_rules     enable row level security;

drop policy if exists "service only" on public.leads;
drop policy if exists "service only" on public.delivery_outbox;
drop policy if exists "service only" on public.state_rules;

create policy "service only" on public.leads
  for all using (false) with check (false);
create policy "service only" on public.delivery_outbox
  for all using (false) with check (false);
create policy "service only" on public.state_rules
  for all using (false) with check (false);

-- lead_counts() is stable/sql and reads public.leads; only the service role
-- ever calls it, and RLS above blocks anon regardless.
revoke all on function public.lead_counts() from anon;
revoke all on function public.claim_outbox_batch(int) from anon;
