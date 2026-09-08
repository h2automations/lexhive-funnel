/**
 * Structured logging.
 *
 * One JSON object per line on stdout. Vercel captures stdout and a log drain
 * forwards it to Better Stack / Axiom / Datadog, so the log line is the
 * interface — not a string a human happens to be able to read. Everything is a
 * field so it can be filtered on: `event:"delivery.failed" destination:"meta_capi"`
 * is a query, `"Meta delivery failed for lead abc"` is a needle in a haystack.
 *
 * Vercel's own function logs are ephemeral (they roll off in hours), so they
 * cannot be the system of record. The drain is.
 *
 * ---------------------------------------------------------------------------
 * PII
 * ---------------------------------------------------------------------------
 * This funnel collects names, emails, phone numbers and a TCPA consent record.
 * None of it goes in a log line. Logs get copied to a third-party vendor,
 * retained on someone else's schedule, and read by people who have no business
 * reason to see a claimant's phone number — a log drain is a data export, and
 * should be treated as one.
 *
 * So the redaction is enforced here rather than left to the discipline of every
 * future call site: `redact()` walks every object logged and strips forbidden
 * keys at any depth. A careless `log.info('x', lead)` emits ids and nothing
 * else. See `log.test.ts` — the guarantee is tested, not asserted.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MIN_LEVEL: number =
  LEVEL_WEIGHT[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVEL_WEIGHT.info;

/**
 * Keys whose values must never be logged, matched case-insensitively after
 * stripping non-alphanumerics (so `first_name`, `firstName` and `FIRST-NAME`
 * are all caught).
 *
 * A denylist is the pragmatic choice for a codebase this size and it is the one
 * that survives contact with new call sites. The stricter design is an allowlist
 * of permitted keys; that is where I would go if this logger were used across a
 * wider surface, because a denylist can only block what someone thought of.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(
  [
    // Direct identifiers
    'email', 'phone', 'firstname', 'lastname', 'name', 'fullname',
    'zip', 'zipcode', 'postalcode', 'address',
    // Meta's hashed-field names, in case a CAPI payload is ever logged whole
    'em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp',
    // Network identifiers — personal data under GDPR
    'clientip', 'ip', 'ipaddress', 'clientipaddress', 'useragent', 'clientuseragent',
    // Tracking identifiers that single a person out
    'fbc', 'fbp', 'fbclid', 'externalid',
    // Free-form fields that carry answers or consent wording
    'answers', 'consenttext', 'contact', 'userdata', 'body', 'payload',
  ].map(normaliseKey)
);

/**
 * Credentials arrive under names nobody predicts — `SUPABASE_SERVICE_ROLE_KEY`
 * defeated an exact-match list on the first test run. So secrets are matched by
 * substring instead, and anything whose name ends in `key` goes too.
 *
 * This over-matches: a field called `monkey_count` would be redacted. That is
 * the correct direction to be wrong in. A redacted field costs one debugging
 * session; a leaked service-role key costs the database.
 */
const FORBIDDEN_FRAGMENTS = [
  'token', 'secret', 'password', 'passwd', 'authorization',
  'cookie', 'credential', 'servicerole', 'dsn', 'dedupe',
];

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isForbidden(key: string): boolean {
  const normalised = normaliseKey(key);
  if (FORBIDDEN_KEYS.has(normalised)) return true;
  if (normalised.endsWith('key')) return true;
  return FORBIDDEN_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

const MAX_DEPTH = 4;
const MAX_STRING = 500;

/**
 * Strip forbidden keys at any depth and bound the size of what is left.
 * Returns a new object; never mutates the caller's.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[depth]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redact(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isForbidden(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return out;
  }

  return String(value);
}

/** Errors serialise to something searchable, with the stack bounded. */
function serialiseError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      error_name: err.name,
      error_message: err.message.slice(0, MAX_STRING),
      stack: err.stack?.split('\n').slice(0, 8).join('\n'),
    };
  }
  return { error_message: String(err).slice(0, MAX_STRING) };
}

export type Context = Record<string, unknown>;

export interface Logger {
  readonly requestId: string;
  debug(event: string, ctx?: Context): void;
  info(event: string, ctx?: Context): void;
  warn(event: string, ctx?: Context): void;
  error(event: string, err?: unknown, ctx?: Context): void;
  /** A logger carrying extra fields on every line — e.g. one outbox row. */
  child(ctx: Context): Logger;
  /** Milliseconds since this logger was created. */
  elapsed(): number;
}

/** Release identifier, so a log line can be tied to the commit that wrote it. */
const RELEASE = (process.env.VERCEL_GIT_COMMIT_SHA ?? 'local').slice(0, 7);
const ENVIRONMENT = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development';

function emit(level: Level, base: Context, event: string, ctx: Context): void {
  if (LEVEL_WEIGHT[level] < MIN_LEVEL) return;

  const line = {
    ts: new Date().toISOString(),
    level,
    service: 'lexhive',
    env: ENVIRONMENT,
    release: RELEASE,
    event,
    ...(redact(base) as Context),
    ...(redact(ctx) as Context),
  };

  // console.error for warn/error so the two streams stay separable even before
  // a drain is attached; the JSON is identical either way.
  const serialised = JSON.stringify(line);
  if (level === 'error' || level === 'warn') console.error(serialised);
  else console.log(serialised);
}

export interface CreateLoggerOptions {
  /** Anything with headers — a VercelRequest, or a plain object in tests. */
  headers?: Record<string, string | string[] | undefined>;
  context?: Context;
}

/**
 * One logger per request. The request id ties every line from a single
 * invocation together, and is handed to the browser in a response header and
 * stored on outbox rows so a delivery three retries later can still be traced
 * back to the submission that created it.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const startedAt = Date.now();
  const header = options.headers?.['x-vercel-id'] ?? options.headers?.['x-request-id'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const requestId = (fromHeader ?? crypto.randomUUID()).slice(0, 100);

  function build(base: Context): Logger {
    return {
      requestId,
      elapsed: () => Date.now() - startedAt,
      debug: (event, ctx = {}) => emit('debug', base, event, ctx),
      info: (event, ctx = {}) => emit('info', base, event, ctx),
      warn: (event, ctx = {}) => emit('warn', base, event, ctx),
      error: (event, err, ctx = {}) =>
        emit('error', base, event, { ...ctx, ...(err ? serialiseError(err) : {}) }),
      child: (ctx: Context) => build({ ...base, ...ctx }),
    };
  }

  return build({ request_id: requestId, ...options.context });
}
