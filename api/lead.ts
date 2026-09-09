/**
 * POST /api/lead
 *
 * The single durability boundary of the whole funnel. Writes (or updates) the
 * lead row in Postgres, enqueues delivery_outbox rows on completion, and
 * returns the server-minted event_id. The request is finished the moment
 * Postgres commits — Meta and Airtable are deliveries, not dependencies.
 *
 * Partial saves UPDATE the row created by the first save rather than inserting
 * a new one. Inserting per step turns one abandoned session into six rows and
 * makes every count on /ops a multiple of the truth.
 */

import { randomUUID, createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger, type Logger } from './_lib/log.js';
import { reportError } from './_lib/sentry.js';
import { createEventRecorder } from './_lib/events.js';
import { stateCodeFrom, classify, type Answers } from './_lib/qualification.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VARIANT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_ANSWERS_BYTES = 8_000;

interface Attribution {
  fbclid?: string | null;
  fbc?: string | null;
  fbp?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  referrer?: string | null;
  firstSeenAt?: number;
}

/** Stable dedupe key over the strongest identifier we hold. */
function dedupeHash(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

/**
 * x-forwarded-for is a list — "client, proxy1, proxy2". Meta wants one address,
 * and the client is the first entry.
 */
function clientIp(req: VercelRequest): string | null {
  const raw = req.headers['x-forwarded-for'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  return value.split(',')[0]!.trim() || null;
}

function truncate(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/**
 * Restriction comes from the `state_rules` table, not a constant in this file.
 * That is the whole point of the table: compliance changes the list with an
 * UPDATE, not a deploy. A lookup error, or a state with no rule at all, is
 * treated as restricted — the safe direction to fail in.
 */
async function isRestricted(stateCode: string, log: Logger): Promise<boolean> {
  if (!stateCode) return false;
  const { data, error } = await supabase
    .from('state_rules')
    .select('restricted')
    .eq('state_code', stateCode)
    .maybeSingle();

  if (error) {
    // Worth an alert: this means compliance routing is running blind, and it
    // will look like an unexplained spike in restricted leads.
    log.error('state_rules.lookup_failed', error, { state_code: stateCode, failing_closed: true });
    void reportError(error, {
      tags: { area: 'compliance' },
      extra: { state_code: stateCode },
      requestId: log.requestId,
    });
    return true;
  }

  // No rule for this code either. Every US state is seeded, so this means an
  // unknown or malformed value — restricted is the safe answer to "may we sell
  // this person's data" when we cannot say where they are.
  if (!data) return true;

  return Boolean(data.restricted);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const log = createLogger({ headers: req.headers, context: { route: 'lead' } });
  const events = createEventRecorder(supabase, log);

  // Handed back so a browser error report, a support ticket, or a Vercel
  // access log can be joined to the log lines for this exact invocation.
  res.setHeader('x-request-id', log.requestId);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = (req.body ?? {}) as Record<string, any>;

  // ---- Validation ---------------------------------------------------
  const variant = typeof body.variant === 'string' && VARIANT_RE.test(body.variant)
    ? body.variant
    : 'qualification-v1';

  const isComplete = body.status === 'complete';
  const answers = (body.answers ?? {}) as Answers;

  if (typeof answers !== 'object' || Array.isArray(answers)) {
    log.warn('lead.rejected', { reason: 'invalid_answers' });
    return res.status(400).json({ error: 'invalid_answers' });
  }
  if (JSON.stringify(answers).length > MAX_ANSWERS_BYTES) {
    log.warn('lead.rejected', { reason: 'answers_too_large' });
    return res.status(413).json({ error: 'answers_too_large' });
  }

  // Resolved rather than truncated: `"New York".slice(0, 2)` is `"NE"`, and
  // Nebraska is unrestricted. See _lib/qualification.ts.
  const stateCode = stateCodeFrom(answers);
  const restricted = await isRestricted(stateCode ?? '', log);
  const disposition = classify({ answers, restricted });

  const contact = (body.contact ?? {}) as Record<string, unknown>;
  const email = truncate(contact.email, 320);
  const phone = truncate(contact.phone, 32);

  // A restricted lead is completed WITHOUT contact details — the funnel never
  // asks for them. Requiring an email or phone regardless made restricted
  // submissions impossible to finish.
  if (isComplete && !restricted && !email && !phone) {
    // A spike here means the contact step is broken, not that users are being
    // careless — worth watching as a rate, not reading as individual lines.
    log.warn('lead.rejected', { reason: 'contact_required', variant, disposition });
    events.add('lead.rejected', {
      disposition,
      state_code: stateCode || null,
      error_code: 'contact_required',
      duration_ms: log.elapsed(),
    });
    await events.flush();
    return res.status(400).json({ error: 'contact_required' });
  }

  const attr: Attribution = body.attribution ?? {};
  const now = new Date().toISOString();
  const consent = (body.consent ?? {}) as Record<string, unknown>;

  const row: Record<string, unknown> = {
    variant,
    status: isComplete ? 'complete' : 'partial',
    disposition,
    answers,
    email,
    phone,
    first_name: truncate(contact.firstName, 100),
    last_name: truncate(contact.lastName, 100),
    state: stateCode || null,
    zip: truncate(contact.zip, 10),
    consent_version: truncate(consent.version, 32),
    consent_text: truncate(consent.text, 2000),
    consent_given: typeof consent.given === 'boolean' ? consent.given : null,
    consent_at: truncate(consent.timestamp, 40),
    submitted_at: isComplete ? now : null,
    first_seen_at: attr.firstSeenAt ? new Date(attr.firstSeenAt).toISOString() : null,
    fbclid: truncate(attr.fbclid, 512),
    fbc: truncate(attr.fbc, 512),
    fbp: truncate(attr.fbp, 512),
    utm_source: truncate(attr.utm_source, 200),
    utm_medium: truncate(attr.utm_medium, 200),
    utm_campaign: truncate(attr.utm_campaign, 200),
    utm_content: truncate(attr.utm_content, 200),
    utm_term: truncate(attr.utm_term, 200),
    referrer: truncate(attr.referrer, 500),
    external_id: truncate(body.externalId, 100),
    client_ip: clientIp(req),
    user_agent: truncate(req.headers['user-agent'], 500),
    dedupe_key: isComplete ? dedupeHash(phone || email || '') : null,
    updated_at: now,
  };

  // Null out keys we have no value for, so a later partial save can't wipe
  // something an earlier one captured (attribution arrives once, at landing).
  for (const key of Object.keys(row)) {
    if (row[key] === null && key !== 'submitted_at') delete row[key];
  }

  // ---- Insert or update ---------------------------------------------
  const existingId =
    typeof body.leadId === 'string' && UUID_RE.test(body.leadId) ? body.leadId : null;

  let leadId = existingId;
  let eventId: string | null = null;
  let created = false;

  /** The durability boundary failing is the one thing here worth paging on. */
  async function failWrite(error: { message: string }) {
    log.error('lead.write_failed', error, { variant, disposition, existing: Boolean(existingId) });
    await reportError(error, {
      tags: { area: 'durability', route: 'lead' },
      extra: { variant, disposition },
      requestId: log.requestId,
    });
    return res.status(500).json({ error: 'db_write_failed', requestId: log.requestId });
  }

  if (existingId) {
    const { data, error } = await supabase
      .from('leads')
      .update(row)
      .eq('id', existingId)
      .select('id, event_id')
      .maybeSingle();

    if (error) return failWrite(error);

    if (data) {
      leadId = data.id;
      eventId = data.event_id;
    } else {
      leadId = null; // id was stale (row purged); fall through to an insert
    }
  }

  if (!leadId) {
    leadId = randomUUID();
    eventId = randomUUID();
    created = true;
    const { error } = await supabase
      .from('leads')
      .insert({ ...row, id: leadId, event_id: eventId, created_at: now });

    if (error) return failWrite(error);
  }

  events.add(created ? 'lead.created' : 'lead.updated', {
    lead_id: leadId,
    disposition,
    state_code: stateCode || null,
    duration_ms: log.elapsed(),
    detail: { variant, step_count: Object.keys(answers).length },
  });

  // ---- Enqueue outbox deliveries (only on complete) ------------------
  if (isComplete) {
    // Guard against a double submit re-enqueueing the same deliveries.
    const { data: existingRows } = await supabase
      .from('delivery_outbox')
      .select('id')
      .eq('lead_id', leadId)
      .limit(1);

    if (!existingRows || existingRows.length === 0) {
      const { error: outboxError } = await supabase.from('delivery_outbox').insert([
        {
          lead_id: leadId,
          destination: 'meta_capi',
          // The originating request id rides along on the outbox row, so a
          // delivery that succeeds forty minutes and three retries later can
          // still be traced back to the submission that created it.
          payload: { event_id: eventId, event_name: 'Lead', request_id: log.requestId },
          status: 'pending',
          attempts: 0,
          max_attempts: 6,
          next_attempt_at: now,
          created_at: now,
          updated_at: now,
        },
        {
          lead_id: leadId,
          destination: 'n8n_airtable',
          payload: { lead_id: leadId, request_id: log.requestId },
          status: 'pending',
          attempts: 0,
          max_attempts: 6,
          next_attempt_at: now,
          created_at: now,
          updated_at: now,
        },
      ]);

      if (outboxError) {
        // The lead is already safe. Delivery is reconciled by /ops, not by
        // failing a request the user is waiting on. It is still an alert: a
        // lead nobody is delivering is a lead nobody is calling.
        log.error('outbox.enqueue_failed', outboxError, { lead_id: leadId });
        await reportError(outboxError, {
          tags: { area: 'delivery', route: 'lead' },
          extra: { lead_id: leadId },
          requestId: log.requestId,
        });
      } else {
        events.add('outbox.enqueued', {
          lead_id: leadId,
          disposition,
          detail: { destinations: ['meta_capi', 'n8n_airtable'] },
        });
      }
    }

    events.add('lead.completed', {
      lead_id: leadId,
      disposition,
      state_code: stateCode || null,
      duration_ms: log.elapsed(),
      detail: {
        variant,
        // Match-quality inputs, as booleans. Whether we hold an fbc is the
        // single best predictor of Meta match rate, and it is a fact about the
        // session rather than about the person.
        has_fbc: Boolean(row.fbc),
        has_fbp: Boolean(row.fbp),
        has_zip: Boolean(row.zip),
        has_email: Boolean(email),
        has_phone: Boolean(phone),
        utm_source: attr.utm_source ?? null,
      },
    });
  }

  log.info(isComplete ? 'lead.completed' : 'lead.saved', {
    lead_id: leadId,
    disposition,
    state_code: stateCode || null,
    variant,
    created,
    duration_ms: log.elapsed(),
  });

  // Flushed before responding: a function frozen on return would otherwise
  // drop the insert.
  await events.flush();

  return res.status(200).json({ leadId, eventId, variant, disposition });
}
