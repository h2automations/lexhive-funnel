-- Runtime config for the n8n outbox drain.
--
-- Copy this file to supabase/seed-app-config.sql (gitignored), fill in the
-- secret, run it once against the project, then delete your copy. It is a
-- separate file from schema.sql for one reason: schema.sql is committed, and
-- this row holds a secret.
--
-- `drain_secret` must match the DRAIN_SECRET environment variable on Vercel
-- byte for byte. /api/drain compares them with timingSafeEqual, so a trailing
-- space is not a validation error — it is a 401 that looks identical to a
-- rotated secret nobody updated. The check constraint on the table rejects
-- surrounding whitespace for exactly that reason.
--
-- Rotating the secret later is this same statement plus the Vercel variable.
-- No workflow edit, no redeploy.

insert into public.app_config (id, public_base_url, drain_secret)
values (
  1,
  'https://lexhive.vercel.app',        -- no trailing slash; the constraint rejects one
  'PASTE_THE_DRAIN_SECRET_FROM_VERCEL'
)
on conflict (id) do update
  set public_base_url = excluded.public_base_url,
      drain_secret    = excluded.drain_secret,
      updated_at      = now();
