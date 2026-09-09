import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  BACKLOG_TIMEOUT_MS,
  LIVENESS_TIMEOUT_MS,
  assessDeliveryHealth,
  summarise,
} from './health.js';

const NOW = new Date('2026-09-09T22:00:00.000Z');
const agoMs = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const healthy = {
  drainLastOkAt: agoMs(30_000),
  oldestWaitingAt: null,
  deadRows: 0,
  now: NOW,
};

test('a drain running on schedule with nothing waiting is healthy', () => {
  const report = assessDeliveryHealth(healthy);
  assert.equal(report.status, 'healthy');
  assert.equal(report.drain_age_s, 30);
  assert.equal(report.oldest_waiting_s, null);
  assert.equal(summarise(report), 'delivery healthy');
});

test('a drain that has never run is degraded, not pending', () => {
  // The failure this whole mechanism exists for: a workflow that was never
  // activated, or was activated and never worked. Treating "no heartbeat yet"
  // as an unknown-but-fine state is how that goes unnoticed for a day.
  const report = assessDeliveryHealth({ ...healthy, drainLastOkAt: null });
  assert.equal(report.status, 'degraded');
  assert.equal(report.checks.find((c) => c.name === 'liveness')?.status, 'degraded');
  assert.match(summarise(report), /never completed a run/);
});

test('a silent drain is degraded once it passes the liveness timeout', () => {
  const justInside = assessDeliveryHealth({
    ...healthy,
    drainLastOkAt: agoMs(LIVENESS_TIMEOUT_MS - 1_000),
  });
  assert.equal(justInside.status, 'healthy');

  const justOutside = assessDeliveryHealth({
    ...healthy,
    drainLastOkAt: agoMs(LIVENESS_TIMEOUT_MS + 1_000),
  });
  assert.equal(justOutside.status, 'degraded');
  assert.match(summarise(justOutside), /liveness: last drain/);
});

test('a fresh heartbeat does not hide a backlog', () => {
  // The case liveness alone cannot see: the drain runs every 60 seconds and
  // fails every delivery. The heartbeat stays perfectly green while nothing
  // reaches Airtable.
  const report = assessDeliveryHealth({
    ...healthy,
    drainLastOkAt: agoMs(5_000),
    oldestWaitingAt: agoMs(BACKLOG_TIMEOUT_MS + 60_000),
  });

  assert.equal(report.status, 'degraded');
  assert.equal(report.checks.find((c) => c.name === 'liveness')?.status, 'healthy');
  assert.equal(report.checks.find((c) => c.name === 'progress')?.status, 'degraded');
});

test('a row retrying inside the backoff ladder is not an alert', () => {
  // Backoff starts at one minute and doubles. A row on its second retry is
  // working exactly as designed, and paging someone for it trains them to
  // ignore the alert.
  const report = assessDeliveryHealth({
    ...healthy,
    oldestWaitingAt: agoMs(BACKLOG_TIMEOUT_MS - 60_000),
  });
  assert.equal(report.status, 'healthy');
});

test('a dead-lettered row is degraded even when everything else is fine', () => {
  // Dead letters do not self-clear: that lead is not going anywhere until a
  // person replays it.
  const report = assessDeliveryHealth({ ...healthy, deadRows: 1 });
  assert.equal(report.status, 'degraded');
  assert.match(summarise(report), /1 dead-lettered row awaiting replay/);

  const many = assessDeliveryHealth({ ...healthy, deadRows: 4 });
  assert.match(summarise(many), /4 dead-lettered rows/);
});

test('clock skew cannot report a stall as a fresh run', () => {
  // Postgres and the function host are different clocks. A timestamp a second
  // in the future must not produce a negative age, which would read as "just
  // ran" and mask a genuine stall in the other direction.
  const report = assessDeliveryHealth({
    ...healthy,
    drainLastOkAt: new Date(NOW.getTime() + 2_000).toISOString(),
  });
  assert.equal(report.drain_age_s, 0);
  assert.equal(report.status, 'healthy');
});

test('an unparseable timestamp is treated as no heartbeat at all', () => {
  const report = assessDeliveryHealth({ ...healthy, drainLastOkAt: 'not a date' });
  assert.equal(report.status, 'degraded');
  assert.equal(report.drain_age_s, null);
});

test('the summary names every failing check and nothing else', () => {
  const report = assessDeliveryHealth({
    drainLastOkAt: agoMs(LIVENESS_TIMEOUT_MS + 1_000),
    oldestWaitingAt: agoMs(BACKLOG_TIMEOUT_MS + 1_000),
    deadRows: 2,
    now: NOW,
  });
  const line = summarise(report);
  assert.match(line, /liveness:/);
  assert.match(line, /progress:/);
  assert.match(line, /loss:/);
  assert.doesNotMatch(line, /healthy/);
});
