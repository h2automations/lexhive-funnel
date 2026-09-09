/**
 * Attribution capture.
 *
 * Tag loading now lives in GTM (see lib/datalayer.ts) — this file no longer
 * touches fbq. What it still owns is the part a tag manager cannot do for you:
 * capturing the click identifiers at the only moment they exist.
 *
 * Attribution is captured on the FIRST pageview and persisted, because the
 * query string (fbclid, utm_*) is gone after the first route change. Cookie
 * identifiers (_fbp, _fbc) are re-read at submit, since the Pixel — wherever it
 * is loaded from — usually writes them only after first paint.
 *
 * These values go to the SERVER, on the lead row, and from there to the
 * Conversions API. They are deliberately not pushed to the dataLayer: the
 * browser Pixel reads its own cookies, and republishing click ids to every tag
 * in the container buys nothing.
 */

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
  return { fbclid, fbc: `fb.${subdomainIndex()}.${firstSeenAt}.${fbclid}`, firstSeenAt };
}

/**
 * The second segment of `_fbc` is the subdomain index of the host the cookie
 * is written on — "com" is 0, "example.com" is 1, "lexhive.vercel.app" is 2.
 * Hardcoding 1 produces a value that disagrees with the cookie Meta writes on
 * any host of a different depth, which is exactly the sort of near-miss that
 * costs match quality without ever raising an error.
 */
function subdomainIndex(): number {
  return Math.max(0, window.location.hostname.split('.').length - 1);
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
