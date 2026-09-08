/**
 * Error reporting to Sentry.
 *
 * Logs tell you what happened; error tracking tells you what broke, groups it,
 * and pages someone. They are not the same job — the bug that cost us a day
 * (a `require()` in an ESM module, throwing on every Meta delivery) produced no
 * alert and no failed request, only outbox rows quietly marked dead. Sentry
 * would have grouped that as one issue on the first delivery.
 *
 * ---------------------------------------------------------------------------
 * Why no @sentry/node
 * ---------------------------------------------------------------------------
 * This posts a Sentry envelope over `fetch`, which is a documented ingest API.
 * The SDK's real value is breadcrumbs, tracing, and automatic instrumentation;
 * for capturing exceptions out of three serverless handlers it costs a
 * megabyte of cold start and a flush lifecycle to manage, for a payload this
 * file builds in forty lines.
 *
 * That trade-off flips the moment anyone wants performance tracing or release
 * health — at which point swap this module for `@sentry/node`'s
 * `captureException` and delete it. The call sites do not change.
 *
 * ---------------------------------------------------------------------------
 * Serverless
 * ---------------------------------------------------------------------------
 * A Vercel function may be frozen the instant it returns a response, so a
 * fire-and-forget POST is a report that sometimes doesn't arrive. Every call
 * here is awaited, with a hard timeout so a slow Sentry can never become a slow
 * funnel. Failure to report is swallowed: an error reporter that throws is
 * worse than no error reporter.
 */

import { redact } from './log.js';

const DSN = process.env.SENTRY_DSN ?? '';
const RELEASE = process.env.VERCEL_GIT_COMMIT_SHA ?? 'local';
const ENVIRONMENT = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development';
const TIMEOUT_MS = 2_000;

interface ParsedDsn {
  endpoint: string;
  publicKey: string;
}

/** DSN shape: https://<publicKey>@<host>/<projectId> */
function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\/+/, '');
    if (!url.username || !projectId) return null;
    return {
      endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
      publicKey: url.username,
    };
  } catch {
    return null;
  }
}

const parsed = parseDsn(DSN);

export interface ReportOptions {
  /** Groups related issues in the Sentry UI — keep it low-cardinality. */
  tags?: Record<string, string>;
  /** Extra context. Passed through the log redactor, so no PII survives. */
  extra?: Record<string, unknown>;
  requestId?: string;
  level?: 'error' | 'warning' | 'fatal';
}

/**
 * Report an exception. No-ops when SENTRY_DSN is unset, which is what makes it
 * safe to call from tests and local development.
 *
 * Returns true if Sentry accepted the event — useful in tests, ignored in
 * production.
 */
export async function reportError(err: unknown, options: ReportOptions = {}): Promise<boolean> {
  if (!parsed) return false;

  const error = err instanceof Error ? err : new Error(String(err));
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const sentAt = new Date().toISOString();

  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: options.level ?? 'error',
    release: RELEASE,
    environment: ENVIRONMENT,
    server_name: 'vercel',
    logger: 'lexhive',
    tags: { ...options.tags, ...(options.requestId ? { request_id: options.requestId } : {}) },
    // Redacted for the same reason log lines are: Sentry is a third-party
    // store, and a claimant's phone number has no business being in it.
    extra: redact(options.extra ?? {}),
    exception: {
      values: [
        {
          type: error.name,
          value: error.message.slice(0, 1000),
          stacktrace: { frames: framesFrom(error) },
        },
      ],
    },
  };

  const envelope =
    `${JSON.stringify({ event_id: eventId, sent_at: sentAt })}\n` +
    `${JSON.stringify({ type: 'event' })}\n` +
    `${JSON.stringify(event)}\n`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(parsed.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': [
          'Sentry sentry_version=7',
          `sentry_client=lexhive/1.0`,
          `sentry_key=${parsed.publicKey}`,
        ].join(', '),
      },
      body: envelope,
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    // Never let the reporter break the thing it is reporting on.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal stack parsing. The SDK does this properly (source maps, in-app
 * detection); this gives Sentry enough to render a readable trace.
 * Sentry expects frames oldest-first, which is the reverse of Error.stack.
 */
function framesFrom(error: Error): { filename: string; function: string; lineno?: number }[] {
  const lines = (error.stack ?? '').split('\n').slice(1, 21);
  const frames = lines
    .map((line) => {
      const match = line.match(/at\s+(.*?)\s+\((.*?):(\d+):\d+\)/) ?? line.match(/at\s+(.*?):(\d+):\d+/);
      if (!match) return null;
      return match.length >= 4
        ? { function: match[1]!, filename: match[2]!, lineno: Number(match[3]) }
        : { function: '<anonymous>', filename: match[1]!, lineno: Number(match[2]) };
    })
    .filter((frame): frame is { filename: string; function: string; lineno: number } => frame !== null);

  return frames.reverse();
}

/** True when error reporting is actually configured — logged at boot. */
export const sentryEnabled = Boolean(parsed);
