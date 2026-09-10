/**
 * POST /api/drain
 *
 * Delivery worker, triggered by an n8n Schedule every 60 seconds.
 *
 * Claims a batch from delivery_outbox (FOR UPDATE SKIP LOCKED so overlapping
 * runs never double-deliver), then dispatches to Meta CAPI and the n8n Airtable
 * webhook. Failure is classified: only retryable errors get another attempt;
 * a definitive 4xx from Meta is dead on arrival.
 *
 * `attempts` is incremented once, by claim_outbox_batch. This worker reads that
 * value and never adds to it — incrementing again here burned two attempts per
 * failure and skipped every other rung of the backoff ladder.
 */

import { timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendMetaEvent } from './_lib/meta-capi.js';
import { createLogger, type Logger } from './_lib/log.js';
import { reportError } from './_lib/sentry.js';
import { createEventRecorder, classifyError, type EventRecorder } from './_lib/events.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const DRAIN_SECRET = process.env.DRAIN_SECRET ?? '';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL ?? '';
const N8N_INTERNAL_SECRET = process.env.N8N_INTERNAL_SECRET ?? '';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID ?? '';
const BATCH_SIZE = 10;
const MAX_BACKOFF_MS = 1_800_000; // 32m ceiling

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Overall deadline for one drain invocation, including time spent reading
 * results. The n8n caller times out at 30s, so a batch of ten sequential
 * ten-second requests would starve the n8n side of the stack; the deadline is
 * what makes a slow destination cost only the rows after it, never everything.
 * Rows that fall out the far side of the deadline stay `delivering` and are
 * reclaimed by the next run after the lease expires. Set
 * `DRAIN_DEADLINE_MS` to match the deployment's own max duration.
 */
const DRAIN_DEADLINE_MS = Number(process.env.DRAIN_DEADLINE_MS ?? 25_000);

interface OutboxRow {
  id: number;
  lead_id: string;
  destination: string;
  payload: Record<string, unknown>;
  /** Already incremented by claim_outbox_batch — never add to it here. */
  attempts: number;
  max_attempts: number;
  /** Enqueue time, used to measure end-to-end delivery latency. */
  created_at: string;
}

interface DeliveryResult {
  ok: boolean;
  retryable: boolean;
  message?: string;
  /** The exact CAPI event Meta accepted, for audit and the e2e suite. */
  sent?: Record<string, unknown>;
}

/** Constant-time compare so a wrong secret can't be found byte by byte. */
function secretMatches(provided: unknown, expected: string): boolean {
  if (!expected) return false;
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorised(req: VercelRequest): boolean {
  return (
    secretMatches(req.headers['x-drain-secret'], DRAIN_SECRET) ||
    secretMatches(req.query.secret, DRAIN_SECRET)
  );
}

async function claimBatch(limit = BATCH_SIZE): Promise<OutboxRow[]> {
  const { error: reconcileError } = await supabase.rpc('reconcile_missing_outbox');
  if (reconcileError) throw reconcileError;
  const { data, error } = await supabase.rpc('claim_outbox_batch', { batch_size: limit });
  if (error) throw error;
  return (data ?? []) as OutboxRow[];
}

/**
 * Read one lead. Returns the row and any query error separately: a failed read
 * is a retryable delivery problem, while an absent row is a permanent
 * `lead_not_found`. Collapsing the two (as an earlier version did) turned a
 * transient database blip into a dead letter.
 */
async function loadLead(leadId: string) {
  const { data, error } = await supabase.from('leads').select('*').eq('id', leadId).maybeSingle();
  return { data, error };
}

async function deliverMeta(row: OutboxRow): Promise<DeliveryResult> {
  const { data: lead, error: leadError } = await loadLead(row.lead_id);
  if (leadError) return { ok: false, retryable: true, message: 'db_read_failed' };
  if (!lead) return { ok: false, retryable: false, message: 'lead_not_found' };

  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const restricted = lead.disposition === 'restricted';

  return sendMetaEvent({
    accessToken: process.env.META_CAPI_ACCESS_TOKEN ?? '',
    // The browser Pixel now gets its id from the GTM container, so the server
    // owns this one outright. The VITE_ fallback that used to be here was a
    // trap: it made the server quietly depend on a browser variable, and it
    // would have kept working right up until someone tidied that variable away.
    pixelId: process.env.META_PIXEL_ID || '',
    apiVersion: process.env.META_API_VERSION || 'v26.0',
    eventName: (row.payload.event_name as string) || 'Lead',
    eventId: (row.payload.event_id as string) || lead.event_id,
    userData: {
      em: lead.email,
      ph: lead.phone,
      fn: lead.first_name,
      ln: lead.last_name,
      // No city is collected, so `ct` is omitted rather than filled with the
      // state — a wrong value is worse than a missing one for match quality.
      st: lead.state,
      zp: lead.zip,
      ge: lead.gender,
      country: 'US',
      external_id: lead.external_id,
      client_ip_address: lead.client_ip,
      client_user_agent: lead.user_agent,
      fbp: lead.fbp,
      fbc: lead.fbc,
    },
    // The moment the person converted, not the moment this attempt runs.
    eventTime: lead.submitted_at
      ? Math.floor(new Date(lead.submitted_at).getTime() / 1000)
      : undefined,
    testEventCode: process.env.META_TEST_EVENT_CODE,
    eventSourceUrl: baseUrl ? `${baseUrl}/${lead.variant}` : undefined,
    limitedDataUse: restricted,
    // Same ceiling as the n8n webhook: one hung destination must not starve
    // the rest of the batch.
    timeoutMs: FETCH_TIMEOUT_MS,
  });
}

async function deliverN8n(row: OutboxRow): Promise<DeliveryResult> {
  if (!N8N_WEBHOOK_URL) {
    return { ok: false, retryable: true, message: 'n8n_webhook_url_not_configured' };
  }
  if (!N8N_INTERNAL_SECRET) {
    return { ok: false, retryable: true, message: 'n8n_internal_secret_not_configured' };
  }
  if (!AIRTABLE_BASE_ID) {
    return { ok: false, retryable: true, message: 'airtable_base_id_not_configured' };
  }

  const { data: lead, error: leadError } = await loadLead(row.lead_id);
  if (leadError) return { ok: false, retryable: true, message: 'db_read_failed' };
  if (!lead) return { ok: false, retryable: false, message: 'lead_not_found' };

  const common = {
    airtable_base_id: AIRTABLE_BASE_ID,
    lead_id: lead.id,
    variant: lead.variant,
    disposition: lead.disposition,
    state: lead.state,
    answers: lead.answers,
    consent_version: lead.consent_version,
    consent_at: lead.consent_at,
    submitted_at: lead.submitted_at,
  };

  // Since follow-up exists there are now TWO contact-bearing reasons to reach
  // n8n — a qualified sales lead and a disqualified nurture opt-in — and two
  // explicit no-contact ones. Restricted AND disqualified-no-opt-in: contact
  // fields never leave this process (a federation side-guard; the store also
  // refuses to enqueue their jobs). The payload carries `lead_type`
  // (Sales | Nurture | None) so the n8n workflow branches on that, never on
  // disposition alone.
  const followUpType = lead.follow_up_type ?? 'none';
  const isNurture = lead.disposition === 'disqualified' && followUpType === 'disqualified_nurture';
  const contactAllowed = lead.disposition === 'qualified' || isNurture;

  const body = contactAllowed
    ? {
        ...common,
        restricted: false,
        lead_type: isNurture ? 'Nurture' : 'Sales',
        first_name: lead.first_name,
        last_name: lead.last_name,
        email: lead.email,
        phone: lead.phone,
        ...(lead.gender ? { gender: lead.gender } : {}),
        zip: lead.zip,
        utm_source: lead.utm_source,
        utm_campaign: lead.utm_campaign,
        has_fbc: Boolean(lead.fbc),
        follow_up_type: followUpType,
        contact_capture_reason: lead.contact_capture_reason ?? null,
        qualification_reason: lead.qualification_reason ?? null,
      }
    : { ...common, restricted: true, lead_type: 'None' };

  // Without a timeout a hung webhook holds the drain open until Vercel kills
  // the whole invocation, taking the other nine rows in the batch with it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': N8N_INTERNAL_SECRET,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      message: err instanceof Error ? err.message : 'network error',
    };
  } finally {
    clearTimeout(timer);
  }

  if (res.ok) return { ok: true, retryable: false };
  return {
    ok: false,
    retryable: res.status >= 500 || res.status === 429,
    message: `HTTP ${res.status}`,
  };
}

/**
 * Stamp the heartbeat that /api/health watches.
 *
 * Written on every successful run, including empty ones, because the signal is
 * its ABSENCE. A drain that stops raises no error anywhere — n8n simply stops
 * calling, `/ops` still looks fine, and the funnel keeps taking leads that go
 * nowhere. This one column is what turns that into something a monitor can
 * see.
 *
 * Never allowed to fail the drain: a heartbeat write that throws must not stop
 * deliveries that already succeeded. A missed stamp degrades health, which is
 * the correct and conservative direction to be wrong in.
 */
async function markDrainAlive(log: Logger): Promise<void> {
  try {
    const { error } = await supabase
      .from('app_config')
      .update({ drain_last_ok_at: new Date().toISOString() })
      .eq('id', 1);
    if (error) throw error;
  } catch (err) {
    log.warn('drain.heartbeat_failed', { error: (err as Error)?.message ?? String(err) });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const log = createLogger({ headers: req.headers, context: { route: 'drain' } });
  const events: EventRecorder = createEventRecorder(supabase, log);
  res.setHeader('x-request-id', log.requestId);

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!authorised(req)) {
    // Repeated 401s here mean either a rotated secret nobody updated in n8n,
    // or someone probing. Both are worth seeing as a rate.
    log.warn('drain.unauthorized');
    return res.status(401).json({ error: 'unauthorized' });
  }

  let claimed: OutboxRow[];
  try {
    claimed = await claimBatch();
  } catch (err) {
    // The drain being unable to claim means nothing is being delivered at all.
    log.error('drain.claim_failed', err);
    await reportError(err, { tags: { area: 'delivery', route: 'drain' }, requestId: log.requestId });
    return res.status(500).json({ error: 'claim_failed', requestId: log.requestId });
  }

  if (claimed.length === 0) {
    // Logged even when idle: this line IS the drain's heartbeat. Its absence
    // for more than a few minutes means n8n has stopped calling us, which is
    // otherwise a completely silent failure — no errors, no alerts, and no
    // leads reaching Airtable.
    await markDrainAlive(log);
    log.info('drain.completed', { processed: 0, duration_ms: log.elapsed() });
    return res.status(200).json({ processed: 0, requestId: log.requestId });
  }

  const summary: Record<string, number> = {};
  let deadLettered = 0;
  let failed = 0;
  let skipped = 0;
  let unresolved = 0;
  const deadlineAt = Date.now() + DRAIN_DEADLINE_MS;

  for (let i = 0; i < claimed.length; i++) {
    const row = claimed[i]!;

    if (Date.now() >= deadlineAt) {
      skipped = claimed.length - i;
      log.warn('drain.deadline_reached', {
        elapsed_ms: log.elapsed(),
        remaining: skipped,
      });
      break;
    }

    // The request id that created this outbox row, so the whole life of one
    // lead — submission, three failed attempts, eventual success — shares a
    // single correlation id in the drain.
    const rowLog = log.child({
      outbox_id: row.id,
      lead_id: row.lead_id,
      destination: row.destination,
      attempt: row.attempts,
      origin_request_id: (row.payload?.request_id as string) ?? null,
    });

    /**
     * Persist a delivery outcome ONLY if this invocation still owns the lease
     * and the exact claim generation. An expired worker must not overwrite a
     * newer worker's result — stale success would both mask a real failure and
     * double-deliver a lead it no longer has authority to report on.
     */
    const persistOutcome = async (patch: Record<string, unknown>, now: string): Promise<boolean> => {
      const { error } = await supabase
        .from('delivery_outbox')
        .update({ ...patch, updated_at: now })
        .eq('id', row.id)
        .eq('status', 'delivering')
        .eq('attempts', row.attempts);
      if (error) {
        rowLog.error('delivery.bookkeeping_failed', error, {
          patch_status: (patch.status as string | undefined) ?? null,
        });
        void reportError(error, {
          tags: { area: 'delivery', route: 'drain', error_code: 'bookkeeping_failed' },
          extra: { outbox_id: row.id, lead_id: row.lead_id, attempts: row.attempts },
          requestId: log.requestId,
        });
        return false;
      }
      return true;
    };

    const startedAt = Date.now();
    let result: DeliveryResult;

    try {
      if (row.destination === 'meta_capi') {
        result = await deliverMeta(row);
      } else if (row.destination === 'n8n_airtable') {
        result = await deliverN8n(row);
      } else {
        result = { ok: false, retryable: false, message: 'unknown_destination' };
      }
    } catch (err) {
      // An unexpected throw is retryable — it tells us nothing about whether
      // the destination would accept the event.
      result = {
        ok: false,
        retryable: true,
        message: err instanceof Error ? err.message : 'handler threw',
      };
    }

    const now = new Date().toISOString();
    const durationMs = Date.now() - startedAt;
    // Time from enqueue to this attempt — the number that answers "how long
    // after someone submits does the lead actually reach the sales team".
    const queueLatencyMs = Date.now() - new Date(row.created_at).getTime();

    if (result.ok) {
      const patch: Record<string, unknown> = { status: 'succeeded', last_error: null };
      // Audit the exact (already-hashed) event Meta accepted, separate from the
      // enqueue metadata so the plaintext never lands in the same blob.
      if (result.sent) patch.payload = { ...row.payload, delivered: result.sent };
      const persisted = await persistOutcome(patch, now);
      if (!persisted) {
        // The destination accepted the event but the record of it did not
        // commit. The row stays leased and is reclaimed and AT LEAST ONCE
        // redelivered (Meta dedup / Airtable upsert make that safe). Do NOT
        // count it as succeeded — bookkeeping failure is not delivery success.
        unresolved += 1;
        events.add('delivery.unresolved', {
          lead_id: row.lead_id,
          outbox_id: row.id,
          destination: row.destination,
          attempt: row.attempts,
          duration_ms: durationMs,
          outcome: 'bookkeeping_failed',
          error_code: 'bookkeeping_failed',
          detail: { queue_latency_ms: queueLatencyMs },
        });
        continue;
      }

      summary[row.destination] = (summary[row.destination] ?? 0) + 1;
      rowLog.info('delivery.succeeded', {
        duration_ms: durationMs,
        queue_latency_ms: queueLatencyMs,
      });
      events.add('delivery.succeeded', {
        lead_id: row.lead_id,
        outbox_id: row.id,
        destination: row.destination,
        attempt: row.attempts,
        duration_ms: durationMs,
        outcome: 'succeeded',
        detail: { queue_latency_ms: queueLatencyMs },
      });
      continue;
    }

    // attempts was incremented at claim time and came back with the row, so
    // there is no second read here.
    const attempts = row.attempts ?? 1;
    const maxAttempts = row.max_attempts ?? 6;
    const exhausted = attempts >= maxAttempts;
    const errorCode = classifyError(result.message);

    if (!result.retryable || exhausted) {
      const persisted = await persistOutcome(
        { status: 'dead', last_error: result.message ?? null },
        now
      );
      if (!persisted) {
        unresolved += 1;
        continue;
      }

      deadLettered += 1;
      rowLog.error('delivery.dead', undefined, {
        error_code: errorCode,
        reason: result.message,
        exhausted,
        duration_ms: durationMs,
        queue_latency_ms: queueLatencyMs,
      });
      events.add('delivery.dead', {
        lead_id: row.lead_id,
        outbox_id: row.id,
        destination: row.destination,
        attempt: attempts,
        duration_ms: durationMs,
        outcome: 'dead',
        error_code: errorCode,
        detail: { exhausted, queue_latency_ms: queueLatencyMs },
      });

      // A dead letter is a lead that will never arrive unless a human acts, so
      // it is persisted in app_events, shown in /ops, and reported to Sentry.
      await reportError(new Error(`delivery dead: ${result.message ?? 'unknown'}`), {
        tags: { area: 'delivery', destination: row.destination, error_code: errorCode },
        extra: { lead_id: row.lead_id, outbox_id: row.id, attempts },
        requestId: log.requestId,
      });
      continue;
    }

    // 1m → 2m → 4m → 8m → 16m → 32m, jittered ±30% so retries don't stampede.
    const baseMs = Math.min(60_000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    const nextAttemptAt = new Date(Date.now() + baseMs * (0.7 + Math.random() * 0.6));

    const persisted = await persistOutcome(
      {
        status: 'failed',
        last_error: result.message ?? null,
        next_attempt_at: nextAttemptAt.toISOString(),
      },
      now
    );
    if (!persisted) {
      unresolved += 1;
      continue;
    }

    failed += 1;
    // A retry is expected behaviour, not an incident — warn, don't error, and
    // let the rate be the thing anyone alerts on.
    rowLog.warn('delivery.failed', {
      error_code: errorCode,
      reason: result.message,
      duration_ms: durationMs,
      next_attempt_at: nextAttemptAt.toISOString(),
      attempts_remaining: maxAttempts - attempts,
    });
    events.add('delivery.failed', {
      lead_id: row.lead_id,
      outbox_id: row.id,
      destination: row.destination,
      attempt: attempts,
      duration_ms: durationMs,
      outcome: 'retrying',
      error_code: errorCode,
      detail: { next_attempt_at: nextAttemptAt.toISOString() },
    });
  }

  await markDrainAlive(log);

  log.info('drain.completed', {
    processed: claimed.length,
    succeeded: Object.values(summary).reduce((total, n) => total + n, 0),
    failed,
    dead_lettered: deadLettered,
    unresolved,
    skipped,
    duration_ms: log.elapsed(),
  });

  await events.flush();

  return res.status(200).json({
    processed: claimed.length,
    summary,
    deadLettered,
    unresolved,
    skipped,
    requestId: log.requestId,
  });
}
