/**
 * A v4 UUID, on every browser.
 *
 * `crypto.randomUUID()` needs a secure context and did not land in Safari until
 * 15.4, so on iOS 15.3 and below it is simply absent — and this funnel's
 * audience is people over 40 arriving from a Meta ad, a population that skews
 * hard toward older iPhones.
 *
 * That matters more than it looks. `/api/lead` validates `submissionId`
 * against a UUID regex and rejects anything else with 400, and the same value
 * becomes `leads.event_id` — the id the browser Pixel and the Conversions API
 * both fire with. The previous fallback here produced
 * `submission-1789017083652-a3f9`, which is not a UUID, so on those browsers
 * every save failed, the completion failed, no lead was stored and no Meta
 * event was sent. Silently: the person saw "Something went wrong", and nothing
 * anywhere recorded that a whole class of device could not convert at all.
 *
 * So the contract this file exists to keep is narrow and absolute: whatever
 * path is taken, the return value matches
 * /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.
 *
 * Three tiers, in descending order of entropy quality:
 *   1. `crypto.randomUUID()` — the real thing.
 *   2. `crypto.getRandomValues()` — CSPRNG bytes, shaped into a v4 by hand.
 *      Available since Safari 6, so in practice this is the branch that runs.
 *   3. `Math.random()` — not cryptographic, and not pretending to be. This is a
 *      collision-avoidance id for one browser session, not a secret: it is
 *      compared against the database by equality and never used to authorise
 *      anything. A weak id here costs a theoretical collision; no id at all
 *      costs the entire conversion.
 */

const HEX: string[] = [];
for (let i = 0; i < 256; i += 1) HEX.push((i + 0x100).toString(16).slice(1));

function randomBytes16(): Uint8Array {
  const bytes = new Uint8Array(16);
  const c = typeof crypto !== 'undefined' ? crypto : undefined;

  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
    return bytes;
  }

  for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export function newUuid(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();

  const b = randomBytes16();
  // The two bits that make it a v4 rather than a random hex string: version 4
  // in the high nibble of byte 6, variant 10xx in the high bits of byte 8.
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;

  const h = Array.from(b, (byte) => HEX[byte]!).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
