/**
 * Minimal Meta Conversions API client. Sends a single event and classifies the
 * response so the outbox can decide whether to retry.
 *
 * Normalization is not cosmetic: hashing an un-normalized phone produces a hash
 * that matches nothing in Meta's systems and fails with no error, so every
 * identifier is normalized before hashing.
 */

import { createHash } from 'crypto';

export interface CapiResult {
  ok: boolean;
  retryable: boolean;
  message?: string;
  received?: boolean;
  /** The exact event Meta accepted (already hashed); the drain audits it. */
  sent?: Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** US E.164 digits: country code + ten-digit national number. */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  return '';
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Meta expects the two-letter code, lowercased — not "New York". */
function normalizeState(state: string): string {
  const s = state.trim().toLowerCase().replace(/[^a-z]/g, '');
  return s.length === 2 ? s : '';
}

function normalizeZip(zip: string): string {
  const d = zip.replace(/\D/g, '');
  return d.length >= 5 ? d.slice(0, 5) : '';
}

/** Meta accepts a single lowercase letter: m or f. Anything else is dropped. */
function normalizeGender(gender: string): string {
  const g = gender.trim().toLowerCase();
  if (g.startsWith('m')) return 'm';
  if (g.startsWith('f')) return 'f';
  return '';
}

function normalizeCountry(country: string): string {
  const c = country.trim().toLowerCase().replace(/[^a-z]/g, '');
  return c.length === 2 ? c : '';
}

export interface CapiUserData {
  em?: string | null;
  ph?: string | null;
  fn?: string | null;
  ln?: string | null;
  ct?: string | null;
  st?: string | null;
  zp?: string | null;
  ge?: string | null;
  country?: string | null;
  external_id?: string | null;
  client_ip_address?: string | null;
  client_user_agent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
}

interface CapiPayload {
  event_name: string;
  event_time: number;
  event_id: string;
  user_data: Record<string, unknown>;
  action_source: string;
  event_source_url?: string;
  data_processing_options?: string[];
  data_processing_options_country?: number;
  data_processing_options_state?: number;
}

/**
 * The request envelope matches Meta's SDK: `test_event_code` sits BESIDE `data`
 * at the request level, not on an individual event. Placing it on the event
 * (as this file historically did) can prevent the Test Events workflow from
 * operating at all while returning HTTP 200, so it was never visible.
 */
interface CapiEnvelope {
  data: CapiPayload[];
  test_event_code?: string;
  access_token: string;
}

/** Hash if there is something left after normalizing; otherwise omit the key. */
function hashed(value: string | null | undefined, normalize: (v: string) => string) {
  if (!value) return undefined;
  const normalized = normalize(value);
  return normalized ? sha256(normalized) : undefined;
}

/**
 * Send a single Conversions API event. Returns { ok, retryable }.
 * A Meta 4xx (invalid parameter) is dead on arrival; 429 and 5xx retry.
 */
export async function sendMetaEvent(args: {
  accessToken: string;
  pixelId: string;
  apiVersion: string;
  eventName: string;
  eventId: string;
  userData: CapiUserData;
  testEventCode?: string;
  eventSourceUrl?: string;
  actionSource?: string;
  /**
   * Whole-exchange deadline, including reading the response. Without one a hung
   * Meta endpoint holds the drain invocation open and starves the rest of the
   * batch (drain.ts), and inline delivery (lead.ts) that the caller bounded.
   * The timer is not cleared until the body is consumed.
   */
  timeoutMs?: number;
  /**
   * Unix seconds of the ORIGINAL conversion, not of this delivery attempt.
   *
   * The drain retries with backoff to a 32-minute ceiling over six attempts, so
   * a lead delivered on attempt four would otherwise reach Meta stamped about
   * an hour after the person actually converted. That misattributes the
   * conversion to the wrong hour, and after a long outage can push it outside
   * the attribution window altogether — the retry machinery quietly corrupting
   * the data it exists to protect.
   */
  eventTime?: number;
  /** Limited Data Use — set for leads from states we treat as restricted. */
  limitedDataUse?: boolean;
}): Promise<CapiResult> {
  const {
    accessToken,
    pixelId,
    apiVersion,
    eventName,
    eventId,
    userData,
    testEventCode,
    eventSourceUrl,
    actionSource = 'website',
    limitedDataUse = false,
    timeoutMs = 10_000,
    eventTime,
  } = args;

  if (!accessToken) {
    return { ok: false, retryable: true, message: 'META_CAPI_ACCESS_TOKEN not configured' };
  }
  if (!pixelId) {
    return { ok: false, retryable: true, message: 'META_PIXEL_ID not configured' };
  }

  const user_data: Record<string, unknown> = {
    em: hashed(userData.em, normalizeEmail),
    ph: hashed(userData.ph, normalizePhone),
    fn: hashed(userData.fn, normalizeName),
    ln: hashed(userData.ln, normalizeName),
    ct: hashed(userData.ct, normalizeName),
    st: hashed(userData.st, normalizeState),
    zp: hashed(userData.zp, normalizeZip),
    ge: hashed(userData.ge, normalizeGender),
    country: hashed(userData.country, normalizeCountry),
    external_id: hashed(userData.external_id, (v) => v.trim()),
    client_ip_address: userData.client_ip_address || undefined,
    client_user_agent: userData.client_user_agent || undefined,
    fbp: userData.fbp || undefined,
    fbc: userData.fbc || undefined,
  };

  for (const key of Object.keys(user_data)) {
    if (user_data[key] === undefined) delete user_data[key];
  }

  const payload: CapiPayload = {
    event_name: eventName,
    // Falls back to now only when the caller has no conversion timestamp.
    event_time: eventTime ?? Math.floor(Date.now() / 1000),
    event_id: eventId,
    user_data,
    action_source: actionSource,
  };

  if (eventSourceUrl) payload.event_source_url = eventSourceUrl;

  if (limitedDataUse) {
    // LDU: Meta processes the event in restricted mode. 0/0 lets Meta infer
    // the location from the request rather than us asserting one.
    payload.data_processing_options = ['LDU'];
    payload.data_processing_options_country = 0;
    payload.data_processing_options_state = 0;
  }

  const envelope: CapiEnvelope = { data: [payload], access_token: accessToken };
  if (testEventCode) envelope.test_event_code = testEventCode;

  const url = `https://graph.facebook.com/${apiVersion}/${pixelId}/events`;

  // One deadline for request AND response: an abort after the headers arrived
  // but mid-body aborts the body read too, which is the hung case that matters.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  let body: { events_received?: number; error?: { message?: string } } = {};
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The token goes in the body, not the query string, so it cannot end up
      // in an intermediary's request log.
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });

    if (res.status === 429 || res.status >= 500) {
      return { ok: false, retryable: true, message: `HTTP ${res.status}` };
    }

    body = (await res.json().catch(() => ({}))) as typeof body;
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? 'request timed out'
        : err instanceof Error
          ? err.message
          : 'network error';
    return { ok: false, retryable: true, message };
  } finally {
    clearTimeout(timer);
  }

  if (res.ok && body.events_received && body.events_received >= 1) {
    return { ok: true, retryable: false, received: true, sent: { ...payload } };
  }

  return {
    ok: false,
    retryable: false,
    message: body?.error?.message ?? `HTTP ${res.status}`,
  };
}
