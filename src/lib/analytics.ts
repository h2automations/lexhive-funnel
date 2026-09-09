/**
 * GA4 and Microsoft Clarity.
 *
 * Both are env-driven and no-op when their id is unset, exactly like the Meta
 * Pixel — so a preview deployment doesn't pollute production analytics, and
 * local development records nothing.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately NOT sent
 * ---------------------------------------------------------------------------
 * This funnel asks whether the person is unable to work because of a medical
 * condition, whether it has lasted twelve months, and whether they are under a
 * doctor's care. Those answers are health data.
 *
 * So the analytics events carry the *step reached* and never the *answer
 * given*: `funnel_step` with a question id and an index, never `work=Yes`. The
 * drop-off curve — which is the thing anyone actually optimises against — is
 * fully visible from that, and no health attribute is attached to a user in a
 * third-party analytics property. Google's own policies prohibit sending health
 * information to Analytics, and the useful reporting does not require it.
 *
 * Contact fields are masked from Clarity in the markup (`data-clarity-mask`),
 * and I would additionally set Clarity's masking mode to Strict in the
 * dashboard rather than relying on the default.
 */

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;
const CLARITY_ID = import.meta.env.VITE_CLARITY_PROJECT_ID as string | undefined;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    clarity?: ((...args: unknown[]) => void) & { q?: unknown[] };
  }
}

let started = false;

/** Load GA4. Uses Google's own snippet semantics — `arguments`, not an array. */
function initGa(): void {
  if (!GA_ID || window.gtag) return;

  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  }
  window.gtag = gtag as unknown as (...args: unknown[]) => void;

  window.gtag('js', new Date());
  window.gtag('config', GA_ID);
}

/** Load Clarity. Same queue-then-replay shape as the Meta Pixel stub. */
function initClarity(): void {
  if (!CLARITY_ID || window.clarity) return;

  const c = function (...args: unknown[]) {
    (c.q = c.q || []).push(args);
  } as ((...args: unknown[]) => void) & { q?: unknown[] };

  window.clarity = c;

  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.clarity.ms/tag/${encodeURIComponent(CLARITY_ID)}`;
  const first = document.getElementsByTagName('script')[0];
  first?.parentNode?.insertBefore(s, first);
}

/**
 * Start both. Called only from the funnel — the `/ops` surface is internal and
 * has no business being session-recorded or counted as marketing traffic.
 */
export function initAnalytics(context: { variant: string }): void {
  if (started) return;
  started = true;

  initGa();
  initClarity();

  // A custom tag so recordings can be filtered by funnel variant, which is what
  // makes Clarity useful for an A/B test rather than just interesting.
  tagClarity('variant', context.variant);
}

/** GA4 event. Params must never carry an answer, a name, or contact details. */
export function trackGaEvent(event: string, params: Record<string, unknown> = {}): void {
  window.gtag?.('event', event, params);
}

/** Clarity custom tag, for filtering recordings. Non-identifying values only. */
export function tagClarity(key: string, value: string): void {
  window.clarity?.('set', key, value);
}
