-- Deployment verification for the LexHive database.
--
-- Read-only and safe to run at any time, against any environment. Run it after
-- schema.sql, and again after seeding app_config. Every row should read `ok`;
-- anything else names what is missing.
--
-- This exists because schema.sql is idempotent, which means running it tells
-- you nothing about whether it worked — `create table if not exists` succeeds
-- just as quietly when the table was already there as when it was not.

with results (ord, check_name, status, detail) as (

  select 1, 'tables',
         case when count(*) = 5 then 'ok' else 'MISSING' end,
         string_agg(table_name, ', ' order by table_name)
  from information_schema.tables
  where table_schema = 'public'
    and table_name in ('leads', 'state_rules', 'delivery_outbox', 'app_events', 'app_config')

  union all
  select 2, 'leads columns',
         case when count(*) = 4 then 'ok' else 'MISSING' end,
         string_agg(column_name, ', ' order by column_name)
  from information_schema.columns
  where table_schema = 'public' and table_name = 'leads'
    and column_name in ('gender', 'submission_id', 'consent_text', 'consent_given')

  union all
  select 3, 'functions',
         case when count(*) = 4 then 'ok' else 'MISSING' end,
         string_agg(p.proname, ', ' order by p.proname)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in
      ('claim_outbox_batch', 'lead_counts', 'delivery_metrics', 'reconcile_missing_outbox')

  union all
  select 4, 'outbox_health view',
         case when count(*) = 1 then 'ok' else 'MISSING' end,
         'the /ops surface reads this'
  from information_schema.views
  where table_schema = 'public' and table_name = 'outbox_health'

  union all
  -- Without security_invoker a view runs as its owner, which would let the
  -- anon key read straight past the RLS below.
  select 5, 'outbox_health security_invoker',
         case when exists (
           select 1 from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'outbox_health'
             and array_to_string(c.reloptions, ',') like '%security_invoker=on%'
         ) then 'ok' else 'OFF' end,
         'anon must not read past RLS through the view'

  union all
  select 6, 'row level security',
         case when count(*) = 5 and count(*) filter (where not c.relrowsecurity) = 0
              then 'ok' else 'CHECK' end,
         string_agg(c.relname || '=' || c.relrowsecurity::text, ', ' order by c.relname)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('leads', 'state_rules', 'delivery_outbox', 'app_events', 'app_config')

  union all
  -- Every state needs an explicit rule: /api/lead treats "no rule" as
  -- restricted, so a missing row silently blocks a whole state from the sales
  -- base. 50 states + DC, of which 12 are restricted.
  select 7, 'state_rules coverage',
         case when count(*) = 51 and (count(*) filter (where restricted)) = 12
              then 'ok' else 'CHECK' end,
         count(*)::text || ' states, ' ||
         (count(*) filter (where restricted))::text || ' restricted'
  from public.state_rules

  union all
  select 8, 'app_config seeded',
         case when count(*) = 1 then 'ok' else 'NOT SEEDED' end,
         coalesce(
           max(public_base_url) || ', secret ' || max(length(drain_secret))::text || ' chars',
           'run supabase/seed-app-config.sql — the drain cannot start without it'
         )
  from public.app_config

  union all
  -- Not schema, but the number worth seeing in the same breath: a backlog that
  -- is not moving means the drain is not running.
  select 9, 'outbox backlog',
         case
           when count(*) filter (where status = 'dead') > 0 then 'DEAD ROWS'
           when count(*) filter (
                  where status in ('pending', 'failed')
                    and next_attempt_at < now() - interval '15 minutes'
                ) > 0 then 'STUCK'
           else 'ok'
         end,
         (count(*) filter (where status = 'succeeded'))::text || ' succeeded, ' ||
         (count(*) filter (where status in ('pending', 'failed')))::text || ' waiting, ' ||
         (count(*) filter (where status = 'dead'))::text || ' dead'
  from public.delivery_outbox

  union all
  -- The dead-man's switch itself. /api/drain stamps this on every successful
  -- run including empty ones, so a stale value means the scheduler stopped
  -- calling — the failure that raises no error anywhere else.
  select 10, 'drain heartbeat',
         case
           when max(drain_last_ok_at) is null then 'NEVER RUN'
           when max(drain_last_ok_at) < now() - interval '5 minutes' then 'STALE'
           else 'ok'
         end,
         coalesce(
           'last ok ' ||
             round(extract(epoch from (now() - max(drain_last_ok_at))))::text || 's ago',
           'the drain has never completed a run — /api/health reports degraded'
         )
  from public.app_config
)
select check_name, status, detail
from results
order by ord;
