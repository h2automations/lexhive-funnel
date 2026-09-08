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
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** US: digits only, no country code. Anything else is dropped, not guessed. */
function normalizePhone(phone: string): string {
  let d = phone.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : '';
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
  test_event_code?: string;
  data_processing_options?: string[];
  data_processing_options_country?: number;
  data_processing_options_state?: number;
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
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    user_data,
    action_source: actionSource,
  };

  if (eventSourceUrl) payload.event_source_url = eventSourceUrl;
  if (testEventCode) payload.test_event_code = testEventCode;

  if (limitedDataUse) {
    // LDU: Meta processes the event in restricted mode. 0/0 lets Meta infer
    // the location from the request rather than us asserting one.
    payload.data_processing_options = ['LDU'];
    payload.data_processing_options_country = 0;
    payload.data_processing_options_state = 0;
  }

  const url = `https://graph.facebook.com/${apiVersion}/${pixelId}/events`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The token goes in the body, not the query string, so it cannot end up
      // in an intermediary's request log.
      body: JSON.stringify({ data: [payload], access_token: accessToken }),
    });
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      message: err instanceof Error ? err.message : 'network error',
    };
  }

  if (res.status === 429 || res.status >= 500) {
    return { ok: false, retryable: true, message: `HTTP ${res.status}` };
  }

  const body = (await res.json().catch(() => ({}))) as {
    events_received?: number;
    error?: { message?: string };
  };

  if (res.ok && body.events_received && body.events_received >= 1) {
    return { ok: true, retryable: false, received: true };
  }

  return {
    ok: false,
    retryable: false,
    message: body?.error?.message ?? `HTTP ${res.status}`,
  };
}
