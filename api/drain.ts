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
const BATCH_SIZE = 10;
const MAX_BACKOFF_MS = 1_800_000; // 32m ceiling

const FETCH_TIMEOUT_MS = 10_000;

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
  const { data, error } = await supabase.rpc('claim_outbox_batch', { batch_size: limit });
  if (error) throw error;
  return (data ?? []) as OutboxRow[];
}

async function loadLead(leadId: string) {
  const { data } = await supabase.from('leads').select('*').eq('id', leadId).maybeSingle();
  return data;
}

async function deliverMeta(row: OutboxRow): Promise<DeliveryResult> {
  const lead = await loadLead(row.lead_id);
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
    apiVersion: process.env.META_API_VERSION || 'v21.0',
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
  });
}

async function deliverN8n(row: OutboxRow): Promise<DeliveryResult> {
  if (!N8N_WEBHOOK_URL) {
    return { ok: false, retryable: true, message: 'n8n_webhook_url_not_configured' };
  }

  const lead = await loadLead(row.lead_id);
  if (!lead) return { ok: false, retryable: false, message: 'lead_not_found' };

  const common = {
    lead_id: lead.id,
    variant: lead.variant,
    disposition: lead.disposition,
    state: lead.state,
    answers: lead.answers,
    consent_version: lead.consent_version,
    consent_at: lead.consent_at,
    submitted_at: lead.submitted_at,
  };

  // Restricted leads: contact fields never leave this process. The n8n workflow
  // strips them again on its side — two layers, because the cost of the second
  // one is a Code node and the cost of missing it is a compliance incident.
  const body =
    lead.disposition === 'restricted'
      ? { ...common, restricted: true }
      : {
          ...common,
          restricted: false,
          first_name: lead.first_name,
          last_name: lead.last_name,
          email: lead.email,
          phone: lead.phone,
          zip: lead.zip,
          utm_source: lead.utm_source,
          utm_campaign: lead.utm_campaign,
          has_fbc: Boolean(lead.fbc),
        };

  // Without a timeout a hung webhook holds the drain open until Vercel kills
  // the whole invocation, taking the other nine rows in the batch with it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

async function notifySlack(message: string, log: Logger) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    log.warn('slack.not_configured');
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message }),
      signal: controller.signal,
    });
  } catch (err) {
    // An alert failing is not worth failing the drain over — but it IS worth
    // knowing about, because a silent alerting channel is worse than none.
    log.warn('slack.notify_failed', { reason: err instanceof Error ? err.message : 'unknown' });
  } finally {
    clearTimeout(timer);
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
    log.info('drain.completed', { processed: 0, duration_ms: log.elapsed() });
    return res.status(200).json({ processed: 0, requestId: log.requestId });
  }

  const summary: Record<string, number> = {};
  let deadLettered = 0;
  let failed = 0;

  for (const row of claimed) {
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
      await supabase
        .from('delivery_outbox')
        .update({ status: 'succeeded', updated_at: now, last_error: null })
        .eq('id', row.id);

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
      await supabase
        .from('delivery_outbox')
        .update({ status: 'dead', last_error: result.message ?? null, updated_at: now })
        .eq('id', row.id);

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
      // it goes to Sentry as well as Slack — Slack scrolls, Sentry groups and
      // counts and can page.
      await reportError(new Error(`delivery dead: ${result.message ?? 'unknown'}`), {
        tags: { area: 'delivery', destination: row.destination, error_code: errorCode },
        extra: { lead_id: row.lead_id, outbox_id: row.id, attempts },
        requestId: log.requestId,
      });
      await notifySlack(
        `LexHive: lead ${row.lead_id.slice(0, 8)} dead-lettered (${row.destination})` +
          `${exhausted ? ` after ${attempts} attempts` : ''}: ${result.message ?? 'unknown'}` +
          ` — replay at ${(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/ops`,
        rowLog
      );
      continue;
    }

    // 1m → 2m → 4m → 8m → 16m → 32m, jittered ±30% so retries don't stampede.
    const baseMs = Math.min(60_000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    const nextAttemptAt = new Date(Date.now() + baseMs * (0.7 + Math.random() * 0.6));

    await supabase
      .from('delivery_outbox')
      .update({
        status: 'failed',
        last_error: result.message ?? null,
        next_attempt_at: nextAttemptAt.toISOString(),
        updated_at: now,
      })
      .eq('id', row.id);

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

  log.info('drain.completed', {
    processed: claimed.length,
    succeeded: Object.values(summary).reduce((total, n) => total + n, 0),
    failed,
    dead_lettered: deadLettered,
    duration_ms: log.elapsed(),
  });

  await events.flush();

  return res
    .status(200)
    .json({ processed: claimed.length, summary, deadLettered, requestId: log.requestId });
}
