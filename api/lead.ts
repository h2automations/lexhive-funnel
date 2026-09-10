/**
 * POST /api/lead
 *
 * The single durability boundary of the whole funnel. Writes (or updates) the
 * lead row in Postgres, enqueues delivery_outbox rows on completion, and
 * returns the database-authoritative event_id. The request is finished the moment
 * Postgres commits — Meta and Airtable are deliveries, not dependencies.
 *
 * Partial saves UPDATE the row created by the first save rather than inserting
 * a new one. Inserting per step turns one abandoned session into six rows and
 * makes every count on /ops a multiple of the truth.
 */

import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger, type Logger } from './_lib/log.js';
import { reportError } from './_lib/sentry.js';
import { createEventRecorder } from './_lib/events.js';
import { stateCodeFrom, classify, qualificationReasonFor, type Answers } from './_lib/qualification.js';
import { decideFollowUp, enforceContactPolicy } from './_lib/follow-up.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VARIANT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_ANSWERS_BYTES = 8_000;
const REQUIRED_ANSWERS = ['age', 'state', 'work', 'duration', 'workHistory', 'doctor'] as const;
const YES_NO = new Set(['Yes', 'No']);
const BINARY_QUESTIONS = ['age', 'work', 'duration', 'workHistory', 'doctor'] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Auto-drain: self-heals so a completed submission is not hostage to the
// external n8n schedule. The schedule remains the retry/backlog backstop.
// Every completion kicks a sweep — no client-side throttle: overlapping
// sweeps are safe because claim_outbox_batch uses FOR UPDATE SKIP LOCKED and
// burns attempts at claim time, so concurrent drains cannot double-deliver.
const DRAIN_SECRET = process.env.DRAIN_SECRET ?? '';
const BASE_URL = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
const DRAIN_TIMEOUT_MS = 4_000;

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

function triggerDrainSweep(log: Logger): Promise<void> {
  if (!DRAIN_SECRET || !BASE_URL) return Promise.resolve();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRAIN_TIMEOUT_MS);

  return fetch(`${BASE_URL}/api/drain`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-drain-secret': DRAIN_SECRET,
    },
    signal: controller.signal,
  })
    .then(() => undefined)
    .catch((err) => {
      log.warn('drain.auto_trigger_failed', { error: err?.message ?? String(err) });
    })
    .finally(() => clearTimeout(timer));
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

  async function reject(reason: string, status = 400) {
    log.warn('lead.rejected', { reason });
    events.add('lead.rejected', {
      error_code: reason,
      duration_ms: log.elapsed(),
    });
    await events.flush();
    return res.status(status).json({ error: reason });
  }

  // ---- Validation ---------------------------------------------------
  const variant = typeof body.variant === 'string' && VARIANT_RE.test(body.variant)
    ? body.variant
    : 'qualification-v1';

  const isComplete = body.status === 'complete';
  if (body.status !== 'partial' && body.status !== 'complete') {
    return reject('invalid_status');
  }
  const submissionId =
    typeof body.submissionId === 'string' && UUID_RE.test(body.submissionId)
      ? body.submissionId
      : null;
  if (!submissionId) return reject('invalid_submission_id');
  const answers = (body.answers ?? {}) as Answers;

  if (typeof answers !== 'object' || Array.isArray(answers)) {
    return reject('invalid_answers');
  }
  if (JSON.stringify(answers).length > MAX_ANSWERS_BYTES) {
    return reject('answers_too_large', 413);
  }

  // Resolved rather than truncated: `"New York".slice(0, 2)` is `"NE"`, and
  // Nebraska is unrestricted. See _lib/qualification.ts.
  const stateCode = stateCodeFrom(answers);

  // Restriction and disposition are decided before validation so an early-exit
  // completion — restricted (exits after the state screen) or disqualified (the
  // moment a knockout answer is "No") — is not held to the FULL answer set.
  // Only a qualified completion must carry all six answers, valid binaries and
  // a resolvable state; anything less is a funnel bug and worth a 400.
  const restricted = await isRestricted(stateCode ?? '', log);
  const disposition = classify({ answers, restricted });
  const earlyExit = restricted || disposition === 'disqualified';

  if (isComplete && !earlyExit) {
    const completeAnswers = REQUIRED_ANSWERS.every(
      (key) => typeof answers[key]?.a === 'string' && Boolean(answers[key]!.a!.trim())
    );
    const validBinary = BINARY_QUESTIONS.every((key) => YES_NO.has(answers[key]?.a ?? ''));
    if (!completeAnswers || !validBinary || !stateCode || stateCode === 'ZZ') {
      return reject('invalid_complete_answers');
    }
  }

  const suppliedContact = (body.contact ?? {}) as Record<string, unknown>;
  const suppliedConsent = (body.consent ?? {}) as Record<string, unknown>;
  // Follow-up is server-authoritative. The browser's opt-in is the one thing
  // policy trusts, and only for the disposition that actually exists: a
  // restricted lead is stripped of ALL contact and consent regardless of what
  // the body claims, and a disqualified no-opt-in never stores a contact.
  const decision = decideFollowUp(disposition, body.followUpOptIn);

  const enforcement = enforceContactPolicy({
    disposition,
    browserOptIn: body.followUpOptIn,
    contact: suppliedContact,
    consent: suppliedConsent,
  });
  if (!enforcement.ok) return reject(enforcement.reason);

  const contact = enforcement.value.contact;
  const consent = enforcement.value.consent;
  const isNurture = decision.followUpType === 'disqualified_nurture';
  const email = truncate(contact.email, 320);
  const phone = truncate(contact.phone, 32);

  // Restricted exits require the no-contact ACKNOWLEDGMENT checked on the raw
  // body first (the checkbox is "I understand", not contact consent); policy
  // then strips everything anyway. A disqualified lead has no consent stage
  // unless they opted into nurture, which enforceContactPolicy already gates.
  if (isComplete && disposition === 'restricted' && suppliedConsent.given !== true) {
    return reject('consent_required');
  }

  // Phone-led contact capture: a callback service needs a phone number and a
  // name to address the caller by. Email and ZIP are optional match/route keys.
  // Restricted and disqualified no-opt-in completions carry NO contact here —
  // and the row builder below only writes contact the disposition permits.
  if (isComplete && (disposition === 'qualified' || isNurture)) {
    const phoneDigits = (phone ?? '').replace(/\D/g, '');
    const validPhone = !phone || phoneDigits.length === 10 || (phoneDigits.length === 11 && phoneDigits.startsWith('1'));
    const firstName = truncate(contact.firstName, 100);
    const lastName = truncate(contact.lastName, 100);
    const emailOk = !email || EMAIL_RE.test(email);
    const zipOk = !truncate(contact.zip, 10) || /^\d{5}$/.test(truncate(contact.zip, 10)!);

    if (isNurture) {
      // Minimal nurture contact: a name plus at least one reachable channel.
      // Format rules match the sales path so a bad phone is a 400 either way.
      const anyChannel = Boolean(email || phone);
      if (!firstName || !anyChannel || (email && !emailOk) || (phone && !validPhone)) {
        return reject('invalid_contact');
      }
    } else if (!firstName || !lastName || !validPhone) {
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
    } else if (!emailOk || !zipOk) {
      return reject('invalid_contact');
    }
  }

  const attr: Attribution = body.attribution ?? {};
  const now = new Date().toISOString();
  // Nurture consent was enforced inside enforceContactPolicy; this gate is the
  // qualified sales consent. Restricted acknowledgment was checked above.
  if (isComplete && disposition === 'qualified' && consent.given !== true) {
    return reject('consent_required');
  }

  const row: Record<string, unknown> = {
    variant,
    submission_id: submissionId,
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
    follow_up_opt_in: decision.followUpOptIn,
    follow_up_type: decision.followUpType,
    follow_up_consent_at: isComplete && decision.followUpOptIn ? now : null,
    contact_capture_reason: decision.contactCaptureReason,
    qualification_reason: disposition === 'disqualified' ? qualificationReasonFor(answers) : null,
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
    dedupe_key: isComplete && (phone || email) ? dedupeHash(phone || email || '') : null,
    updated_at: now,
  };

  // Null out keys we have no value for, so a later partial save can't wipe
  // something an earlier one captured (attribution arrives once, at landing).
  for (const key of Object.keys(row)) {
    const restrictedContactKey = restricted && ['email', 'phone', 'first_name', 'last_name', 'zip'].includes(key);
    if (row[key] === null && key !== 'submitted_at' && !restrictedContactKey) delete row[key];
  }

  // ---- Insert or update ---------------------------------------------
  const existingId =
    typeof body.leadId === 'string' && UUID_RE.test(body.leadId) ? body.leadId : null;

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

  // A completed lead is a terminal record. Its event id, conversion timestamp,
  // consent artifact and finalized answers are the FIRST completion's, forever:
  // a later partial save or an identical duplicate completion must not rewrite
  // them (the browser's save queue is a convenience, not a server-side
  // invariant). So the existing row is read by submission_id before ANY write.
  const { data: bySubmission, error: bySubmissionError } = await supabase
    .from('leads')
    .select('id, event_id, status, submission_id')
    .eq('submission_id', submissionId)
    .maybeSingle();
  if (bySubmissionError) return failWrite(bySubmissionError);

  let existing = bySubmission ?? null;
  if (!existing && existingId) {
    const { data, error } = await supabase
      .from('leads')
      .select('id, event_id, status, submission_id')
      .eq('id', existingId)
      .maybeSingle();
    if (error) return failWrite(error);
    // A leadId that belongs to a DIFFERENT submission is not a fall-through —
    // it is one session writing over another's row.
    if (data && data.submission_id && data.submission_id !== submissionId) {
      return reject('lead_id_mismatch');
    }
    existing = data ?? null;
  }

  let leadId: string | null = existing?.id ?? null;
  let eventId: string | null = existing?.event_id ?? null;
  let created = false;

  /** Reply with the completion that is already on record, without touching it. */
  async function returnExisting() {
    events.add('lead.duplicate_ignored', {
      lead_id: leadId,
      disposition,
      state_code: stateCode || null,
      detail: { variant, existing_status: existing?.status ?? null },
    });
    log.info(isComplete ? 'lead.completed' : 'lead.saved', {
      lead_id: leadId,
      disposition,
      state_code: stateCode || null,
      variant,
      created: false,
      duration_ms: log.elapsed(),
    });
    await events.flush();
    return res.status(200).json({ leadId, eventId, variant, disposition });
  }

  if (existing && existing.status === 'complete') {
    return returnExisting();
  }

  if (leadId) {
    // Finalization is guarded on the surviving lifecycle state: of two racing
    // completions exactly one can flip status 'partial' → 'complete'; the loser
    // matches no row and settles on the winner's result below rather than
    // overwriting it.
    let update = supabase
      .from('leads')
      .update(row)
      .eq('id', leadId)
      .eq('submission_id', submissionId);
    if (isComplete) update = update.eq('status', 'partial');

    const { data, error } = await update.select('id, event_id, status').maybeSingle();
    if (error) return failWrite(error);

    if (data) {
      leadId = data.id;
      eventId = data.event_id;
    } else {
      // Either a racing completion won (status no longer 'partial') or the row
      // was purged mid-request. Re-read; never mutate what the race preserved.
      const { data: current, error: reReadError } = await supabase
        .from('leads')
        .select('id, event_id, status')
        .eq('submission_id', submissionId)
        .maybeSingle();
      if (reReadError) return failWrite(reReadError);
      if (current) {
        leadId = current.id;
        eventId = current.event_id;
        if (current.status === 'complete') {
          existing = { ...current, submission_id: submissionId };
          return returnExisting();
        }
      } else {
        leadId = null; // id was stale (row purged); fall through to an insert
      }
    }
  }

  if (!leadId) {
    // Deterministic for this browser submission, so two racing first saves
    // converge on the same row and event id. Verification note (readiness
    // review): a unique index does NOT make a racing insert return success —
    // the conflict has to be handled, which is why this upserts rather than
    // inserting, and re-reads the winner when a race is lost.
    leadId = submissionId;
    eventId = submissionId;
    created = true;
    const { error } = await supabase
      .from('leads')
      .upsert(
        { ...row, id: leadId, event_id: eventId, created_at: now },
        { onConflict: 'submission_id', ignoreDuplicates: true }
      );

    if (error) return failWrite(error);

    const { data, error: readError } = await supabase
      .from('leads')
      .select('id, event_id')
      .eq('submission_id', submissionId)
      .maybeSingle();
    if (readError) return failWrite(readError);
    if (!data) return failWrite(new Error('lead row missing after insert'));
    leadId = data.id;
    eventId = data.event_id;
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
    // Qualified and opted-in nurture get WORK. Disqualified-no-opt-in and
    // restricted get none: no sales row, no nurture row, no Meta event —
    // the spec's core rule is that those people are not leads, so nothing
    // downstream is allowed to treat them as one.
    const deliveries = [];
    if (disposition === 'qualified') {
      deliveries.push({
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
      });
      deliveries.push({
        lead_id: leadId,
        destination: 'n8n_airtable',
        payload: { lead_id: leadId, request_id: log.requestId },
        status: 'pending',
        attempts: 0,
        max_attempts: 6,
        next_attempt_at: now,
        created_at: now,
        updated_at: now,
      });
    } else if (disposition === 'disqualified' && decision.followUpOptIn) {
      // A nurture opt-in is its own event, deliberately NOT the qualified
      // `Lead` conversion: it must not train Meta to optimise for people who
      // did not qualify. event_id is namespaced so it can never collide with
      // a qualified Lead's id.
      deliveries.push({
        lead_id: leadId,
        destination: 'meta_capi',
        payload: {
          event_id: `nurture_${leadId}`,
          event_name: 'NurtureOptIn',
          request_id: log.requestId,
        },
        status: 'pending',
        attempts: 0,
        max_attempts: 6,
        next_attempt_at: now,
        created_at: now,
        updated_at: now,
      });
      deliveries.push({
        lead_id: leadId,
        destination: 'n8n_airtable',
        payload: { lead_id: leadId, request_id: log.requestId, nurture: true },
        status: 'pending',
        attempts: 0,
        max_attempts: 6,
        next_attempt_at: now,
        created_at: now,
        updated_at: now,
      });
    }

    if (deliveries.length > 0) {
      const { error: outboxError } = await supabase.from('delivery_outbox').upsert(deliveries, {
        onConflict: 'lead_id,destination',
        ignoreDuplicates: true,
      });

      if (outboxError) {
        // The lead is already safe. The drain's reconciliation pass recreates
        // any missing delivery rows before it claims work.
        log.error('outbox.enqueue_failed', outboxError, { lead_id: leadId, disposition });
        await reportError(outboxError, {
          tags: { area: 'delivery', route: 'lead' },
          extra: { lead_id: leadId },
          requestId: log.requestId,
        });
      } else {
        events.add('outbox.enqueued', {
          lead_id: leadId,
          disposition,
          detail: {
            destinations: deliveries.map((d) => d.destination),
            follow_up_type: decision.followUpType,
          },
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

  // Self-heal: a bounded drain sweep BEFORE the response. Work left running
  // after a sent response is not guaranteed to execute on Vercel (the
  // invocation can be frozen), so the client absorbs the sweep cost instead of
  // the delivery being lost. Under backlog the sweep may fall short — the n8n
  // schedule remains the retry/backlog backstop.
  if (isComplete) {
    await triggerDrainSweep(log);
  }

  res.status(200).json({ leadId, eventId, variant, disposition });
}
