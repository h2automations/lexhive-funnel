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
import { sendMetaEvent } from './_lib/meta-capi';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const DRAIN_SECRET = process.env.DRAIN_SECRET ?? '';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL ?? '';
const BATCH_SIZE = 10;
const MAX_BACKOFF_MS = 1_800_000; // 32m ceiling

interface OutboxRow {
  id: number;
  lead_id: string;
  destination: string;
  payload: Record<string, unknown>;
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
    // Server-side name first. VITE_ variables are browser variables; relying on
    // one here only worked because it happened to be set on Vercel too.
    pixelId: process.env.META_PIXEL_ID || process.env.VITE_META_PIXEL_ID || '',
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
      country: 'US',
      external_id: lead.external_id,
      client_ip_address: lead.client_ip,
      client_user_agent: lead.user_agent,
      fbp: lead.fbp,
      fbc: lead.fbc,
    },
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

  let res: Response;
  try {
    res = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      message: err instanceof Error ? err.message : 'network error',
    };
  }

  if (res.ok) return { ok: true, retryable: false };
  return {
    ok: false,
    retryable: res.status >= 500 || res.status === 429,
    message: `HTTP ${res.status}`,
  };
}

async function notifySlack(message: string) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
  } catch {
    /* an alert failing is not worth failing the drain over */
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!authorised(req)) return res.status(401).json({ error: 'unauthorized' });

  let claimed: OutboxRow[];
  try {
    claimed = await claimBatch();
  } catch (err) {
    return res.status(500).json({
      error: 'claim_failed',
      detail: err instanceof Error ? err.message : 'unknown',
    });
  }

  if (claimed.length === 0) return res.status(200).json({ processed: 0 });

  const summary: Record<string, number> = {};
  let deadLettered = 0;

  for (const row of claimed) {
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

    if (result.ok) {
      await supabase
        .from('delivery_outbox')
        .update({ status: 'succeeded', updated_at: now, last_error: null })
        .eq('id', row.id);
      summary[row.destination] = (summary[row.destination] ?? 0) + 1;
      continue;
    }

    // attempts was already incremented at claim time.
    const { data: rec } = await supabase
      .from('delivery_outbox')
      .select('attempts, max_attempts')
      .eq('id', row.id)
      .maybeSingle();

    const attempts = rec?.attempts ?? 1;
    const maxAttempts = rec?.max_attempts ?? 6;
    const exhausted = attempts >= maxAttempts;

    if (!result.retryable || exhausted) {
      await supabase
        .from('delivery_outbox')
        .update({ status: 'dead', last_error: result.message ?? null, updated_at: now })
        .eq('id', row.id);
      deadLettered += 1;
      await notifySlack(
        `LexHive: lead ${row.lead_id.slice(0, 8)} dead-lettered (${row.destination})` +
          `${exhausted ? ` after ${attempts} attempts` : ''}: ${result.message ?? 'unknown'}` +
          ` — replay at ${(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/ops`
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
  }

  return res.status(200).json({ processed: claimed.length, summary, deadLettered });
}
