import assert from 'node:assert/strict';
import test from 'node:test';
import { newUuid } from './uuid.js';

/**
 * The server's regex, copied verbatim from api/lead.ts. Copied rather than
 * imported on purpose: this test exists to prove the browser satisfies the
 * server's contract, and importing the server's constant would make the two
 * drift together and prove nothing.
 */
const SERVER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Run `fn` with parts of globalThis.crypto removed, then put it back. */
function withCrypto(shape: 'full' | 'no-randomUUID' | 'none', fn: () => void) {
  const original = globalThis.crypto;
  try {
    if (shape === 'no-randomUUID') {
      Object.defineProperty(globalThis, 'crypto', {
        value: { getRandomValues: original.getRandomValues.bind(original) },
        configurable: true,
      });
    } else if (shape === 'none') {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    }
    fn();
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
  }
}

test('a modern browser gets a UUID the server accepts', () => {
  withCrypto('full', () => {
    const id = newUuid();
    assert.match(id, SERVER_UUID_RE);
    assert.match(id, V4_RE);
  });
});

test('Safari 15.3 — no crypto.randomUUID — still gets a UUID the server accepts', () => {
  withCrypto('no-randomUUID', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newUuid();
      assert.match(id, SERVER_UUID_RE, `${id} would be rejected by /api/lead as invalid_submission_id`);
      assert.match(id, V4_RE, `${id} is not a valid v4 UUID`);
    }
  });
});

test('no Web Crypto at all — the last resort is still UUID-shaped', () => {
  withCrypto('none', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newUuid();
      assert.match(id, SERVER_UUID_RE);
      assert.match(id, V4_RE);
    }
  });
});

test('ids are distinct, on every path', () => {
  for (const shape of ['full', 'no-randomUUID', 'none'] as const) {
    withCrypto(shape, () => {
      const seen = new Set<string>();
      for (let i = 0; i < 2_000; i += 1) seen.add(newUuid());
      assert.equal(seen.size, 2_000, `${shape}: generated a duplicate id in 2,000 draws`);
    });
  }
});

test('the old fallback shape is exactly what the server rejects', () => {
  // The regression this file exists to prevent, asserted rather than described.
  const old = `submission-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  assert.equal(SERVER_UUID_RE.test(old), false);
  assert.match(newUuid(), SERVER_UUID_RE);
});
