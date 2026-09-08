/**
 * GET  /api/ops                 → delivery health summary
 * POST /api/ops  { outboxId }   → reset a row for immediate retry
 *
 * The key travels in the `x-ops-key` header on both verbs. A query parameter
 * would put it in Vercel's access logs, the browser's history, and the referrer
 * of anything the page links to.
 *
 * Deliberately returns no personal data. Whoever is debugging a delivery
 * failure at 2am does not need the lead's name and phone number to do it.
 */

import { timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from './_lib/log.js';
import { createEventRecorder } from './_lib/events.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

function authorised(req: VercelRequest): boolean {
  const expected = process.env.OPS_KEY ?? process.env.DRAIN_SECRET ?? '';
  if (!expected) return false;

  const raw = req.headers['x-ops-key'];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  if (typeof provided !== 'string') return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const log = createLogger({ headers: req.headers, context: { route: 'ops' } });
  const events = createEventRecorder(supabase, log);
  res.setHeader('x-request-id', log.requestId);

  if (!authorised(req)) {
    // The ops key is the only thing between the public internet and a delivery
    // control surface. Failed attempts are worth counting.
    log.warn('ops.unauthorized', { method: req.method });
    return res.status(401).json({ error: 'unauthorized' });
  }

  // ---- Replay --------------------------------------------------------
  if (req.method === 'POST') {
    const { outboxId } = (req.body ?? {}) as { outboxId?: unknown };
    const id = Number(outboxId);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'outbox_id_required' });
    }

    // Resetting attempts to 0 restores the full retry budget; next_attempt_at
    // = now means the next drain cycle picks it up.
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('delivery_outbox')
      .update({
        status: 'pending',
        attempts: 0,
        next_attempt_at: now,
        last_error: null,
        updated_at: now,
      })
      .eq('id', id);

    if (error) {
      log.error('ops.replay_failed', error, { outbox_id: id });
      return res.status(500).json({ error: 'replay_failed', requestId: log.requestId });
    }

    // Replay is a human overriding the system's own judgement. That is exactly
    // the kind of action you want a record of afterwards.
    log.info('delivery.replayed', { outbox_id: id });
    events.add('delivery.replayed', { outbox_id: id, outcome: 'requeued' });
    await events.flush();

    return res.status(200).json({ ok: true, outboxId: id });
  }

  // ---- Health --------------------------------------------------------
  const [{ data: health }, { data: problems }, { data: recent }] = await Promise.all([
    supabase.from('outbox_health').select('*'),

    supabase
      .from('delivery_outbox')
      .select(
        'id, lead_id, destination, status, attempts, max_attempts, last_error, next_attempt_at, updated_at'
      )
      .in('status', ['failed', 'dead'])
      .order('updated_at', { ascending: false })
      .limit(50),

    supabase
      .from('delivery_outbox')
      .select('id, lead_id, destination, status, attempts, updated_at')
      .order('updated_at', { ascending: false })
      .limit(20),
  ]);

  // Funnel counts and delivery timings are aggregated in Postgres rather than
  // by pulling rows into the function and calling .filter() on them.
  const [{ data: counts }, { data: metrics }] = await Promise.all([
    supabase.rpc('lead_counts'),
    supabase.rpc('delivery_metrics', { window_hours: 24 }),
  ]);

  const funnel = {
    partial: 0,
    complete: 0,
    qualified: 0,
    restricted: 0,
    disqualified: 0,
    ...(counts?.[0] ?? {}),
  };

  log.info('ops.viewed', { duration_ms: log.elapsed(), problem_count: problems?.length ?? 0 });

  return res.status(200).json({
    health,
    problems,
    recent,
    funnel,
    metrics: metrics ?? [],
    requestId: log.requestId,
  });
}
