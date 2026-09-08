/**
 * Tests for the logging redactor.
 *
 * The PII guarantee is the one thing in this codebase that must not be a
 * convention. "We don't log personal data" is a claim; this file is the
 * evidence, and it fails the build the day someone adds a field that leaks.
 *
 * Run: npm test
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { redact, createLogger } from './log.js';

test('redacts direct identifiers', () => {
  const out = redact({
    lead_id: 'abc-123',
    email: 'claimant@example.com',
    phone: '+1 415 555 0134',
    first_name: 'Jane',
    last_name: 'Doe',
    zip: '10001',
  }) as Record<string, unknown>;

  assert.equal(out.lead_id, 'abc-123', 'ids survive — they are the point');
  for (const key of ['email', 'phone', 'first_name', 'last_name', 'zip']) {
    assert.equal(out[key], '[redacted]', `${key} must be redacted`);
  }
});

test('key matching ignores case and separators', () => {
  const out = redact({
    firstName: 'Jane',
    'FIRST-NAME': 'Jane',
    first_name: 'Jane',
    User_Agent: 'Mozilla/5.0',
    clientIp: '203.0.113.9',
  }) as Record<string, unknown>;

  for (const value of Object.values(out)) {
    assert.equal(value, '[redacted]');
  }
});

test('redacts at depth, not just the top level', () => {
  const out = redact({
    lead: { id: 'abc', contact: { email: 'x@y.com' } },
    batch: [{ phone: '555' }, { state: 'NY' }],
  }) as any;

  assert.equal(out.lead.id, 'abc');
  assert.equal(out.lead.contact, '[redacted]', 'a whole contact object is refused');
  assert.equal(out.batch[0].phone, '[redacted]');
  assert.equal(out.batch[1].state, 'NY', 'a state code is not personal data');
});

test('redacts credentials', () => {
  const out = redact({
    access_token: 'EAAG...',
    SUPABASE_SERVICE_ROLE_KEY: 'ey...',
    authorization: 'Bearer abc',
  }) as Record<string, unknown>;

  for (const value of Object.values(out)) {
    assert.equal(value, '[redacted]');
  }
});

test('bounds strings, arrays and depth so one log line cannot blow up a bill', () => {
  const long = redact({ note: 'x'.repeat(5000) }) as Record<string, string>;
  assert.ok(long.note.length < 600, 'long strings are truncated');

  const wide = redact({ items: Array.from({ length: 500 }, (_, i) => i) }) as any;
  assert.equal(wide.items.length, 20, 'arrays are capped');

  const deep = redact({ a: { b: { c: { d: { e: { f: 'too far' } } } } } }) as any;
  assert.equal(deep.a.b.c.d.e, '[depth]');
});

test('a whole lead row logs as ids and nothing else', () => {
  // The realistic accident: someone logs the row they just wrote.
  const leadRow = {
    id: 'lead-1',
    disposition: 'restricted',
    state: 'NY',
    email: 'claimant@example.com',
    phone: '4155550134',
    first_name: 'Jane',
    client_ip: '203.0.113.9',
    user_agent: 'Mozilla/5.0',
    fbc: 'fb.2.123.abc',
    answers: { work: { a: 'Yes' } },
    consent_text: 'I consent to be contacted…',
  };

  const serialised = JSON.stringify(redact(leadRow));

  for (const leak of ['claimant@example.com', '4155550134', 'Jane', '203.0.113.9', 'Mozilla', 'fb.2.123.abc', 'I consent']) {
    assert.ok(!serialised.includes(leak), `leaked: ${leak}`);
  }
  assert.ok(serialised.includes('lead-1'));
  assert.ok(serialised.includes('restricted'));
  assert.ok(serialised.includes('NY'));
});

test('emits one JSON line carrying level, event and request id', () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);

  try {
    const log = createLogger({ headers: { 'x-vercel-id': 'iad1::abc123' } });
    log.info('lead.created', { lead_id: 'lead-1', email: 'x@y.com' });

    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.event, 'lead.created');
    assert.equal(parsed.service, 'lexhive');
    assert.equal(parsed.request_id, 'iad1::abc123');
    assert.equal(parsed.lead_id, 'lead-1');
    assert.equal(parsed.email, '[redacted]');
    assert.ok(parsed.ts, 'every line is timestamped');
  } finally {
    console.log = original;
  }
});

test('child loggers inherit context and keep the same request id', () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: string) => lines.push(line);

  try {
    const log = createLogger({ headers: { 'x-vercel-id': 'req-9' } });
    log.child({ outbox_id: 42 }).error('delivery.dead', new Error('HTTP 400'));

    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.request_id, 'req-9');
    assert.equal(parsed.outbox_id, 42);
    assert.equal(parsed.error_message, 'HTTP 400');
    assert.equal(parsed.level, 'error');
  } finally {
    console.error = original;
  }
});
