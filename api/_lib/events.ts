/**
 * Domain events, written to Postgres.
 *
 * This is deliberately not "logging to the database". The log drain handles
 * debug volume; this table holds the handful of events the business needs to
 * answer questions about itself:
 *
 *   - how long a lead takes to reach Meta, at p50 and p95
 *   - how often a destination fails, and with what
 *   - which step people abandon at
 *   - what /ops replayed, and whether it worked
 *
 * Those are joins against `leads` and `delivery_outbox`, which is exactly what
 * a log vendor is bad at and Postgres is good at. Keeping them here also means
 * /ops answers from one query rather than a vendor API.
 *
 * The table holds no personal data — same rule as the logs — so it can be
 * exported to a BI tool, or handed to a client, without a review.
 *
 * ---------------------------------------------------------------------------
 * Buffered, then flushed once
 * ---------------------------------------------------------------------------
 * A serverless function may be frozen the moment it responds, so an unawaited
 * insert is an insert that sometimes doesn't happen. Awaiting one round trip
 * per event would put database latency on the critical path of a form
 * submission. So events buffer in memory and flush in a single insert before
 * the handler returns: one round trip, no lost rows.
 *
 * A flush failure is logged and swallowed. Analytics must never be the reason
 * a lead is lost — that is the same principle the outbox is built on.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { redact, type Logger } from './log.js';

export type EventName =
  | 'lead.created'
  | 'lead.updated'
  | 'lead.completed'
  | 'lead.rejected'
  | 'outbox.enqueued'
  | 'delivery.attempted'
  | 'delivery.succeeded'
  | 'delivery.failed'
  | 'delivery.dead'
  | 'delivery.replayed'
  | 'drain.completed';

export interface EventFields {
  lead_id?: string | null;
  outbox_id?: number | null;
  destination?: string | null;
  disposition?: string | null;
  state_code?: string | null;
  attempt?: number | null;
  duration_ms?: number | null;
  outcome?: string | null;
  error_code?: string | null;
  detail?: Record<string, unknown>;
}

interface EventRow extends EventFields {
  event: EventName;
  request_id: string;
  occurred_at: string;
}

export interface EventRecorder {
  add(event: EventName, fields?: EventFields): void;
  flush(): Promise<void>;
  readonly size: number;
}

/**
 * `error_code` is a short, low-cardinality classification — 'http_429',
 * 'network', 'lead_not_found' — not the raw error message. Grouping on a
 * message that embeds an id or a timestamp gives you a million groups of one.
 */
export function classifyError(message: string | undefined | null): string {
  if (!message) return 'unknown';
  const httpMatch = message.match(/HTTP (\d{3})/);
  if (httpMatch) return `http_${httpMatch[1]}`;
  if (/timeout|abort/i.test(message)) return 'timeout';
  if (/network|fetch failed|ECONN|ENOTFOUND/i.test(message)) return 'network';
  if (/not_configured/i.test(message)) return 'not_configured';
  if (/lead_not_found/i.test(message)) return 'lead_not_found';
  return message.slice(0, 40).replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase();
}

export function createEventRecorder(
  supabase: SupabaseClient,
  log: Logger
): EventRecorder {
  const buffer: EventRow[] = [];

  return {
    get size() {
      return buffer.length;
    },

    add(event, fields = {}) {
      buffer.push({
        event,
        request_id: log.requestId,
        occurred_at: new Date().toISOString(),
        ...fields,
        detail: (redact(fields.detail ?? {}) as Record<string, unknown>) ?? {},
      });
    },

    async flush() {
      if (buffer.length === 0) return;
      const rows = buffer.splice(0, buffer.length);

      const { error } = await supabase.from('app_events').insert(rows);
      if (error) {
        // Deliberately not rethrown. The caller's work is already committed.
        log.warn('events.flush_failed', { count: rows.length, reason: error.message });
      }
    },
  };
}
