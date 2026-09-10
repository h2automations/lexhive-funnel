/**
 * GET /api/health
 *
 * The dead-man's switch, exposed. Unauthenticated on purpose: it returns three
 * ages, a count and one public identifier — no personal data and no secrets —
 * and a health check that needs a credential is a health check nobody wires up.
 *
 * The identifier is `meta_pixel_id`, and it is here to close the one
 * deduplication failure that is otherwise completely silent. The browser gets
 * its pixel id from the GTM container; the server gets it from
 * `META_PIXEL_ID`. If those two ever diverge, both events keep being sent,
 * both keep returning success, and they simply land in different pixels and
 * never meet — the symptom reads as "deduplication stopped working" with
 * nothing broken anywhere to find. Returning it makes the mismatch checkable
 * from outside, which is what `tests/tags.spec.ts` does. It is not a secret to
 * give away: a pixel id is in the page source of every visitor's browser.
 *
 * 200 when delivery is healthy, 503 when it is not — so any uptime monitor,
 * including ones that cannot read a response body, works against it with no
 * configuration at all. `n8n/lexhive-delivery-monitor.json` reads the body for
 * a useful alert; a Better Stack or Pingdom check on the status code alone
 * would catch the same outage.
 *
 * Deliberately independent of the drain it watches. If this ran inside the
 * drain workflow, the failure mode it exists to catch — that workflow not
 * running — would take the monitor down with it.
 */

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { assessDeliveryHealth, summarise } from './_lib/health.js';
import { createLogger } from './_lib/log.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const log = createLogger({ headers: req.headers, context: { route: 'health' } });
  res.setHeader('x-request-id', log.requestId);
  // A cached health check is a health check that lies.
  res.setHeader('cache-control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const [heartbeat, oldest, dead] = await Promise.all([
      supabase.from('app_config').select('drain_last_ok_at').eq('id', 1).maybeSingle(),
      supabase
        .from('delivery_outbox')
        .select('created_at')
        .in('status', ['pending', 'failed'])
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('delivery_outbox')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'dead'),
    ]);

    const firstError = heartbeat.error ?? oldest.error ?? dead.error;
    if (firstError) throw firstError;

    const report = assessDeliveryHealth({
      drainLastOkAt: (heartbeat.data?.drain_last_ok_at as string | null) ?? null,
      oldestWaitingAt: (oldest.data?.created_at as string | null) ?? null,
      deadRows: dead.count ?? 0,
    });

    if (report.status === 'degraded') {
      log.warn('health.degraded', { summary: summarise(report) });
    }

    return res.status(report.status === 'healthy' ? 200 : 503).json({
      ...report,
      summary: summarise(report),
      // Null rather than '' when unset, so "not configured" is distinguishable
      // from "configured as an empty string" by anything reading this.
      meta_pixel_id: process.env.META_PIXEL_ID || null,
      checked_at: new Date().toISOString(),
      requestId: log.requestId,
    });
  } catch (err) {
    // Unreachable database is itself an outage, and reporting it as anything
    // other than degraded would make this endpoint the quiet failure.
    log.error('health.check_failed', err);
    return res.status(503).json({
      status: 'degraded',
      summary: 'health check could not read the database',
      requestId: log.requestId,
    });
  }
}
