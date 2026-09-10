/**
 * Tests for the Conversions API client.
 *
 * Normalization is the whole game here and it fails silently when wrong: Meta
 * accepts a hash of an un-normalized phone number, returns 200, matches it
 * against nobody, and reports no error. The only way to know the hashing is
 * right is to assert the exact digest against a value normalized by hand.
 *
 * Retry classification gets the same treatment. Retrying a 400 wastes the
 * attempt budget on an event Meta will never accept; not retrying a 429 throws
 * away a lead that would have gone through a minute later.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { sendMetaEvent } from './meta-capi.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

interface Captured {
  url: string;
  body: any;
}

/** Swap global fetch for one that records the request and returns `response`. */
function stubFetch(response: { ok: boolean; status: number; json: unknown }) {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return { ok: response.ok, status: response.status, json: async () => response.json };
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const baseArgs = {
  accessToken: 'test-token',
  pixelId: '123456',
  apiVersion: 'v26.0',
  eventName: 'Lead',
  eventId: 'event-1',
};

test('identifiers are normalized before hashing', async () => {
  const { calls, restore } = stubFetch({ ok: true, status: 200, json: { events_received: 1 } });

  try {
    await sendMetaEvent({
      ...baseArgs,
      userData: {
        em: '  Claimant.Name@EXAMPLE.com ',
        ph: '+1 (415) 555-0134',
        fn: '  Jane  ',
        ln: 'Doe',
        st: 'NY',
        zp: '10001-1234',
        country: 'US',
        external_id: 'session-abc',
      },
    });

    const userData = calls[0]!.body.data[0].user_data;

    assert.equal(userData.em, sha256('claimant.name@example.com'), 'email: trimmed and lowercased');
    assert.equal(userData.ph, sha256('14155550134'), 'phone: US country code retained');
    assert.equal(userData.fn, sha256('jane'), 'name: trimmed and lowercased');
    assert.equal(userData.st, sha256('ny'), 'state: two-letter code, lowercased');
    assert.equal(userData.zp, sha256('10001'), 'zip: first five digits');
    assert.equal(userData.country, sha256('us'), 'country: two-letter, lowercased');
    assert.equal(userData.external_id, sha256('session-abc'));
  } finally {
    restore();
  }
});

test('the request envelope is exactly data + test_event_code + access_token', async () => {
  // Sandbox events are a debug aid, so the flag lives at the REQUEST level next
  // to `data`, where it cannot leak into an event object that could later be
  // sent against a real pixel. `access_token` travels in the same envelope —
  // body, never query string — and the test asserts the event object stays
  // clean of both.
  const { calls, restore } = stubFetch({ ok: true, status: 200, json: { events_received: 1 } });

  try {
    await sendMetaEvent({
      ...baseArgs,
      eventId: 'event-1',
      testEventCode: 'TEST12345',
      userData: { em: 'a@b.com', ph: '4155550134' },
    });

    const body = calls[0]!.body;
    assert.equal(body.access_token, 'test-token');
    assert.equal(body.test_event_code, 'TEST12345');
    assert.ok(body.data, 'data envelopes the events');
    assert.deepEqual(
      Object.keys(body).sort(),
      ['access_token', 'data', 'test_event_code'],
      'no stray keys on the request envelope'
    );

    const event = body.data[0] as Record<string, unknown>;
    assert.ok(!('test_event_code' in event), 'sandbox flag must not sit inside an event');
    assert.ok(!('access_token' in event), 'token must not sit inside an event');
    assert.equal(event.event_id, 'event-1');
  } finally {
    restore();
  }
});

test('gender normalizes to m or f, and opting out sends nothing', async () => {
  for (const [input, expected] of [['Male', 'm'], ['f', 'f'], ['FEMALE', 'f'], ['m', 'm']] as const) {
    const { calls, restore } = stubFetch({ ok: true, status: 200, json: { events_received: 1 } });
    try {
      await sendMetaEvent({ ...baseArgs, userData: { ge: input } });
      assert.equal(calls[0]!.body.data[0].user_data.ge, sha256(expected), `${input} -> ${expected}`);
    } finally {
      restore();
    }
  }

  // "Prefer not to say" must send no field at all, not a hash of a placeholder.
  const { calls, restore } = stubFetch({ ok: true, status: 200, json: { events_received: 1 } });
  try {
    await sendMetaEvent({ ...baseArgs, userData: { ge: 'undisclosed' } });
    assert.ok(!('ge' in calls[0]!.body.data[0].user_data));
  } finally {
    restore();
  }
});

test('event_time is the conversion moment, not the delivery attempt', async () => {
  // The bug this guards: the drain retries with backoff to a 32-minute ceiling,
  // so stamping Date.now() at delivery reports the conversion in the wrong hour
  // and, after a long outage, can push it outside the attribution window.
  const convertedAt = 1_700_000_000;
  const { calls, restore } = stubFetch({ ok: true, status: 200, json: { events_received: 1 } });

  try {
    await sendMetaEvent({ ...baseArgs, userData: {}, eventTime: convertedAt });
    assert.equal(calls[0]!.body.data[0].event_time, convertedAt);
  } finally {
    restore();
  }

  const now = stubFetch({ ok: true, status: 200, json: { events_received: 1 } });
  try {
    await sendMetaEvent({ ...baseArgs, userData: {} });
    const stamped = now.calls[0]!.body.data[0].event_time;
    assert.ok(Math.abs(stamped - Date.now() / 1000) < 5, 'falls back to now when unknown');
  } finally {
    now.restore();
  }
});

test('an unusable phone number is dropped, not hashed into noise', async () => {
  const { calls, restore } = stubFetch({ ok: true, status: 200, json: { events_received: 1 } });

  try {
    await sendMetaEvent({ ...baseArgs, userData: { ph: '555-1234' } }); // too short
    assert.ok(!('ph' in calls[0]!.body.data[0].user_data), 'a hash that matches nothing is worse than an absent field');
  } finally {
    restore();
  }
});

test('empty and missing fields are omitted rather than sent as empty hashes', async () => {
  const { calls, restore } = stubFetch({ ok: true, status: 200, json: { events_received: 1 } });

  try {
    await sendMetaEvent({
      ...baseArgs,
      userData: { em: 'a@b.com', ct: null, fbc: null, fn: '' },
    });

    const userData = calls[0]!.body.data[0].user_data;
    assert.ok('em' in userData);
    assert.ok(!('ct' in userData), 'no city is collected, so none is claimed');
    assert.ok(!('fbc' in userData));
    assert.ok(!('fn' in userData));
  } finally {
    restore();
  }
});

test('unhashed fields stay unhashed', async () => {
  const { calls, restore } = stubFetch({ ok: true, status: 200, json: { events_received: 1 } });

  try {
    await sendMetaEvent({
      ...baseArgs,
      userData: {
        client_ip_address: '203.0.113.9',
        client_user_agent: 'Mozilla/5.0',
        fbp: 'fb.2.1700000000000.1234567890',
        fbc: 'fb.2.1700000000000.abc123',
      },
    });

    const userData = calls[0]!.body.data[0].user_data;
    assert.equal(userData.client_ip_address, '203.0.113.9');
    assert.equal(userData.fbc, 'fb.2.1700000000000.abc123', 'Meta expects fbc raw, not hashed');
  } finally {
    restore();
  }
});

test('the access token goes in the body, never the query string', async () => {
  const { calls, restore } = stubFetch({ ok: true, status: 200, json: { events_received: 1 } });

  try {
    await sendMetaEvent({ ...baseArgs, userData: { em: 'a@b.com' } });
    assert.ok(!calls[0]!.url.includes('access_token'), 'a token in a URL ends up in every intermediary log');
    assert.equal(calls[0]!.body.access_token, 'test-token');
  } finally {
    restore();
  }
});

test('the event id is passed through for browser/server deduplication', async () => {
  const { calls, restore } = stubFetch({ ok: true, status: 200, json: { events_received: 1 } });

  try {
    await sendMetaEvent({ ...baseArgs, eventId: 'shared-id-42', userData: {} });
    assert.equal(calls[0]!.body.data[0].event_id, 'shared-id-42');
  } finally {
    restore();
  }
});

test('Limited Data Use is set for restricted leads only', async () => {
  let stub = stubFetch({ ok: true, status: 200, json: { events_received: 1 } });
  try {
    await sendMetaEvent({ ...baseArgs, userData: {}, limitedDataUse: true });
    assert.deepEqual(stub.calls[0]!.body.data[0].data_processing_options, ['LDU']);
  } finally {
    stub.restore();
  }

  stub = stubFetch({ ok: true, status: 200, json: { events_received: 1 } });
  try {
    await sendMetaEvent({ ...baseArgs, userData: {} });
    assert.ok(!('data_processing_options' in stub.calls[0]!.body.data[0]));
  } finally {
    stub.restore();
  }
});

test('a 400 is dead on arrival; a 429 and a 503 are retryable', async () => {
  const cases = [
    { status: 400, ok: false, json: { error: { message: 'invalid parameter' } }, retryable: false },
    { status: 403, ok: false, json: { error: { message: 'bad token' } }, retryable: false },
    { status: 429, ok: false, json: {}, retryable: true },
    { status: 503, ok: false, json: {}, retryable: true },
  ];

  for (const c of cases) {
    const { restore } = stubFetch(c);
    try {
      const result = await sendMetaEvent({ ...baseArgs, userData: {} });
      assert.equal(result.ok, false, `HTTP ${c.status} is not a success`);
      assert.equal(result.retryable, c.retryable, `HTTP ${c.status} retryable=${c.retryable}`);
    } finally {
      restore();
    }
  }
});

test('a network failure is retryable — it says nothing about the event', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;

  try {
    const result = await sendMetaEvent({ ...baseArgs, userData: {} });
    assert.equal(result.retryable, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('a hung exchange aborts and is retried, not dead-lettered', async () => {
  // Without a timeout the drain worker could sit on a stalled socket past the
  // n8n caller's own 30s limit and get killed mid-attempt — the one failure
  // mode where the attempt budget burns and NO outcome is recorded.
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string, init: RequestInit) =>
    new Promise((_, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;

  try {
    const started = Date.now();
    const result = await sendMetaEvent({ ...baseArgs, userData: {}, timeoutMs: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.ok(Date.now() - started < 2_000, 'the abort fires, it does not hang forever');
  } finally {
    globalThis.fetch = original;
  }
});

test('missing configuration is retryable, not a dead letter', async () => {
  // An unset token is an operator error that someone will fix. Burning the
  // attempt budget on it would throw away every lead in the meantime.
  const noToken = await sendMetaEvent({ ...baseArgs, accessToken: '', userData: {} });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.retryable, true);

  const noPixel = await sendMetaEvent({ ...baseArgs, pixelId: '', userData: {} });
  assert.equal(noPixel.retryable, true);
});
