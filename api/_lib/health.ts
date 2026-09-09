/**
 * Delivery health: the dead-man's switch.
 *
 * `PRODUCTION.md` called a stopped drain the most likely silent failure in this
 * system — no errors, no alerts, `/ops` looking fine, the funnel still taking
 * leads, and nothing reaching anyone. That is exactly what happened: the n8n
 * Schedule resolved `{{ $env.PUBLIC_BASE_URL }}` to the string
 * "[ERROR: access to env vars denied]" and POSTed to it every sixty seconds
 * for a day. Nothing anywhere said a word. This file is the part that would
 * have.
 *
 * Three signals, because they fail differently and any one of them alone lets
 * a real outage through:
 *
 *   liveness  — is the drain running at all? A heartbeat written on every
 *               successful run, including empty ones. Absence is the signal.
 *   progress  — is it getting anywhere? A drain that runs on schedule and
 *               fails every delivery keeps its heartbeat perfectly fresh while
 *               the backlog grows. Liveness cannot see that; the age of the
 *               oldest waiting row can.
 *   loss      — has anything been given up on? A dead-lettered row is a lead
 *               that will never be delivered unless a person replays it, so it
 *               is the one signal that should never self-clear.
 *
 * Pure functions, no I/O: the thresholds and the verdict are the part worth
 * testing, and testing them should not require a database or a clock.
 */

/** The drain runs every 60s. Five missed ticks is not a blip. */
export const LIVENESS_TIMEOUT_MS = 5 * 60_000;

/**
 * Ten minutes of a row sitting unclaimed. Generous on purpose: the backoff
 * ladder starts at one minute and doubles, so a row legitimately retrying
 * twice is still inside this window and must not page anyone.
 */
export const BACKLOG_TIMEOUT_MS = 10 * 60_000;

export type HealthStatus = 'healthy' | 'degraded';

export interface HealthCheck {
  name: 'liveness' | 'progress' | 'loss';
  status: HealthStatus;
  detail: string;
}

export interface HealthReport {
  status: HealthStatus;
  checks: HealthCheck[];
  /** Seconds since the drain last completed, or null if it never has. */
  drain_age_s: number | null;
  /** Seconds the oldest undelivered row has been waiting, or null if none. */
  oldest_waiting_s: number | null;
  dead_rows: number;
}

export interface HealthInput {
  /** `app_config.drain_last_ok_at` — written by /api/drain on every success. */
  drainLastOkAt: string | Date | null;
  /** `created_at` of the oldest outbox row still pending or failed. */
  oldestWaitingAt: string | Date | null;
  /** Rows that exhausted their attempts and were dead-lettered. */
  deadRows: number;
  now?: Date;
}

function ageMs(value: string | Date | null, now: Date): number | null {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  const ms = at.getTime();
  if (!Number.isFinite(ms)) return null;
  // A clock skew between Postgres and the function host can put a timestamp
  // marginally in the future. Clamp rather than report a negative age, which
  // would read as "just ran" and hide a genuine stall.
  return Math.max(0, now.getTime() - ms);
}

function seconds(ms: number | null): number | null {
  return ms === null ? null : Math.round(ms / 1000);
}

export function assessDeliveryHealth(input: HealthInput): HealthReport {
  const now = input.now ?? new Date();
  const drainAge = ageMs(input.drainLastOkAt, now);
  const waitingAge = ageMs(input.oldestWaitingAt, now);
  const deadRows = Number.isFinite(input.deadRows) ? Math.max(0, input.deadRows) : 0;

  const checks: HealthCheck[] = [];

  // A drain that has never run is the failure this exists to catch, not a
  // pending state to be generous about. It reports degraded from the first
  // check, which is what makes a workflow that was never activated visible on
  // day one rather than on the day someone asks where the leads went.
  if (drainAge === null) {
    checks.push({
      name: 'liveness',
      status: 'degraded',
      detail: 'the drain has never completed a run',
    });
  } else if (drainAge > LIVENESS_TIMEOUT_MS) {
    checks.push({
      name: 'liveness',
      status: 'degraded',
      detail: `last drain ${seconds(drainAge)}s ago (limit ${LIVENESS_TIMEOUT_MS / 1000}s)`,
    });
  } else {
    checks.push({
      name: 'liveness',
      status: 'healthy',
      detail: `last drain ${seconds(drainAge)}s ago`,
    });
  }

  if (waitingAge === null) {
    checks.push({ name: 'progress', status: 'healthy', detail: 'nothing waiting' });
  } else if (waitingAge > BACKLOG_TIMEOUT_MS) {
    checks.push({
      name: 'progress',
      status: 'degraded',
      detail: `oldest undelivered row is ${seconds(waitingAge)}s old (limit ${BACKLOG_TIMEOUT_MS / 1000}s)`,
    });
  } else {
    checks.push({
      name: 'progress',
      status: 'healthy',
      detail: `oldest undelivered row is ${seconds(waitingAge)}s old`,
    });
  }

  checks.push(
    deadRows > 0
      ? {
          name: 'loss',
          status: 'degraded',
          detail: `${deadRows} dead-lettered row${deadRows === 1 ? '' : 's'} awaiting replay`,
        }
      : { name: 'loss', status: 'healthy', detail: 'no dead-lettered rows' }
  );

  return {
    status: checks.some((c) => c.status === 'degraded') ? 'degraded' : 'healthy',
    checks,
    drain_age_s: seconds(drainAge),
    oldest_waiting_s: seconds(waitingAge),
    dead_rows: deadRows,
  };
}

/** One line, for an alert body. Only degraded checks — nobody reads the rest. */
export function summarise(report: HealthReport): string {
  const failing = report.checks.filter((c) => c.status === 'degraded');
  if (failing.length === 0) return 'delivery healthy';
  return failing.map((c) => `${c.name}: ${c.detail}`).join(' · ');
}
