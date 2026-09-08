/**
 * Client-side Meta Pixel setup plus attribution capture.
 *
 * The stub below is Meta's canonical one. That matters: fbevents.js replays
 * whatever is sitting in `fbq.queue` once it loads, so a hand-rolled shim
 * without that array silently discards every call made before the script
 * arrives — which is all of them, including `init` and `PageView`.
 *
 * Attribution is captured on the FIRST pageview and persisted, because the
 * query string (fbclid, utm_*) is gone after the first route change. Cookie
 * identifiers (_fbp, _fbc) are re-read at submit since the Pixel script often
 * writes them only after first paint.
 */

type FbqFn = {
  (...args: unknown[]): void;
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[];
  push: unknown;
  loaded: boolean;
  version: string;
};

declare global {
  interface Window {
    fbq?: FbqFn;
    _fbq?: FbqFn;
  }
}

export interface Attribution {
  fbclid: string | null;
  fbc: string | null;
  fbp: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  referrer: string;
  firstSeenAt: number;
}

const PIXEL_ID = import.meta.env.VITE_META_PIXEL_ID as string | undefined;
const SESSION_KEY = 'lexhive_session_id';
const FIRST_SEEN_KEY = 'lexhive_first_seen';
const ATTRIBUTION_KEY = 'lexhive_attribution';

/** sessionStorage throws in some privacy modes; never let it break the funnel. */
function safeGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable; the value just won't survive a reload */
  }
}

/** Set or reuse a first-party session UUID used as Meta's external_id. */
export function getExternalId(): string {
  let id = safeGet(SESSION_KEY);
  if (!id) {
    id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    safeSet(SESSION_KEY, id);
  }
  return id;
}

/**
 * Load the Meta Pixel and initialise it with advanced matching.
 *
 * Safe to call twice (React StrictMode double-invokes effects in dev): the
 * `window.fbq` guard makes the second call a no-op.
 */
export function initPixel(externalId: string): void {
  if (!PIXEL_ID) {
    if (import.meta.env.DEV) {
      console.warn('[lexhive] VITE_META_PIXEL_ID is not set — Pixel disabled.');
    }
    return;
  }
  if (window.fbq) return;

  const n = function (...args: unknown[]) {
    if (n.callMethod) {
      n.callMethod.apply(n, args);
    } else {
      n.queue.push(args);
    }
  } as unknown as FbqFn;

  n.queue = [];
  n.push = n;
  n.loaded = true;
  n.version = '2.0';

  window.fbq = n;
  window._fbq = n;

  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://connect.facebook.net/en_US/fbevents.js';
  document.head.appendChild(s);

  // external_id in advanced matching. The Pixel hashes it in the browser and
  // the server sends SHA-256 of the same value, so the two match.
  window.fbq('init', PIXEL_ID, { external_id: externalId });
  window.fbq('track', 'PageView');
}

/**
 * Track a STANDARD Meta event (Lead, PageView, …), optionally with the
 * server-minted event_id that deduplicates it against the Conversions API.
 */
export function trackEvent(
  event: string,
  data?: Record<string, unknown>,
  eventId?: string
): void {
  if (!window.fbq) return;
  if (eventId) {
    window.fbq('track', event, data ?? {}, { eventID: eventId });
  } else {
    window.fbq('track', event, data ?? {});
  }
}

/**
 * Track a CUSTOM event. Funnel step names are not standard events — sending
 * them through `track` makes Meta drop them as unrecognised.
 */
export function trackCustom(event: string, data?: Record<string, unknown>): void {
  if (!window.fbq) return;
  window.fbq('trackCustom', event, data ?? {});
}

function readFirstSeenAt(): number {
  const existing = safeGet(FIRST_SEEN_KEY);
  if (existing && Number(existing) > 0) return Number(existing);
  const now = Date.now();
  safeSet(FIRST_SEEN_KEY, String(now));
  return now;
}

/**
 * Rebuild the `_fbc` cookie when only `fbclid` is present in the URL. Uses the
 * session's first touch time, not the current time, so a lead that submits ten
 * minutes later still carries the click's real timestamp.
 */
export function reconstructFbc():
  | { fbclid: string; fbc: string; firstSeenAt: number }
  | null {
  const params = new URLSearchParams(window.location.search);
  const fbclid = params.get('fbclid');
  if (!fbclid) return null;

  const firstSeenAt = readFirstSeenAt();
  return { fbclid, fbc: `fb.1.${firstSeenAt}.${fbclid}`, firstSeenAt };
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Capture all attribution at landing time and persist it for the session. */
export function captureAttribution(): Attribution {
  const params = new URLSearchParams(window.location.search);
  const rebuilt = reconstructFbc();
  const firstSeenAt = readFirstSeenAt();

  const attribution: Attribution = {
    fbclid: params.get('fbclid'),
    // A real _fbc cookie wins; the reconstruction is the fallback.
    fbc: readCookie('_fbc') ?? rebuilt?.fbc ?? null,
    fbp: readCookie('_fbp'),
    utm_source: params.get('utm_source'),
    utm_medium: params.get('utm_medium'),
    utm_campaign: params.get('utm_campaign'),
    utm_content: params.get('utm_content'),
    utm_term: params.get('utm_term'),
    referrer: document.referrer,
    firstSeenAt,
  };

  safeSet(ATTRIBUTION_KEY, JSON.stringify(attribution));
  return attribution;
}

/** Read attribution from a previous pageview if present, else recapture. */
export function getAttribution(): Attribution {
  const raw = safeGet(ATTRIBUTION_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as Attribution;
    } catch {
      /* corrupt value; fall through to recapture */
    }
  }
  return captureAttribution();
}

/**
 * Re-read cookies at submit time (the Pixel usually writes _fbp/_fbc after
 * first paint) and persist whatever improved.
 */
export function refreshCookies(attr: Attribution): Attribution {
  const fbp = readCookie('_fbp');
  const fbc = readCookie('_fbc');
  if (fbp) attr.fbp = fbp;
  if (fbc) attr.fbc = fbc;
  if (!attr.fbc) attr.fbc = reconstructFbc()?.fbc ?? null;
  safeSet(ATTRIBUTION_KEY, JSON.stringify(attr));
  return attr;
}
