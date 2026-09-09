/**
 * The dataLayer contract.
 *
 * Every tag — Meta Pixel, GA4 — is configured in GTM container
 * GTM-P34XGVL3. This file is the entire interface between the application and
 * the marketing stack: the app describes what happened, GTM decides who hears
 * about it. Adding a vendor becomes a container change rather than a deploy,
 * which is the point of a tag manager.
 *
 * ---------------------------------------------------------------------------
 * event_id is load-bearing
 * ---------------------------------------------------------------------------
 * `/api/lead` validates and persists the submission UUID as `event_id`, then
 * returns the database-authoritative value.
 * The server sends that same id to the Conversions API. For the browser and
 * server events to deduplicate into one conversion, the Meta Pixel tag in GTM
 * MUST map its Event ID field to the `event_id` pushed here.
 *
 * If that mapping is missing, nothing breaks visibly — no error, no failed tag,
 * a green tick in Preview mode — and every conversion is counted twice. That is
 * the single most fragile link in this design, and it now lives in a GTM field
 * rather than in code, which is the real cost of moving tags into a container.
 * `docs/gtm-setup.md` spells the mapping out.
 *
 * ---------------------------------------------------------------------------
 * What is never pushed
 * ---------------------------------------------------------------------------
 * No name, email, phone, ZIP, or answer text. Anything on the dataLayer is
 * readable by every tag in the container and by anyone who opens the console,
 * so it is treated as published to all vendors at once.
 *
 * Funnel steps carry an ordinal only — not the question's semantic id. Meta
 * flagged this domain under its Business Tool Terms as "associated with medical
 * conditions", and a variable reading `question: "doctor"` on a disability
 * questionnaire is a direct contribution to that classification. The ordinal
 * gives an identical drop-off curve. Semantic ids live in `app_events`, which
 * is our database rather than an ad platform's.
 */

declare global {
  interface Window {
    dataLayer?: Record<string, unknown>[];
  }
}

function push(payload: Record<string, unknown>): void {
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push(payload);
}

/**
 * Fired once the funnel has mounted and a session id exists.
 *
 * The Meta Pixel base tag should trigger on THIS, not on All Pages. GTM loads
 * before React mounts, so a base tag on All Pages fires before `external_id`
 * exists and initialises advanced matching with nothing — silently, and only
 * for the first pageview of every session, which is the hardest kind of gap to
 * notice in a match-quality report.
 */
export function funnelReady(context: { variant: string; externalId: string }): void {
  push({
    event: 'funnel_ready',
    variant: context.variant,
    // A first-party random session UUID. Not personal data on its own, and it
    // survives cookie loss mid-funnel.
    external_id: context.externalId,
  });
}

/** One per answered question. Ordinal only — see the note above. */
export function funnelStep(context: { stepNumber: number; variant: string }): void {
  push({
    event: 'funnel_step',
    step_number: context.stepNumber,
    variant: context.variant,
  });
}

/**
 * The conversion. `event_id` is the server-persisted id shared with the
 * Conversions API — map it to the Meta tag's Event ID field.
 */
export function leadSubmitted(context: {
  eventId: string;
  variant: string;
  disposition: string;
}): void {
  push({
    event: 'application_submitted',
    event_id: context.eventId,
    variant: context.variant,
    // qualified | restricted | disqualified. Useful for excluding restricted
    // leads from optimisation, and non-identifying.
    disposition: context.disposition,
  });

  if (context.disposition === 'qualified') {
    push({
      event: 'qualified_lead',
      event_id: context.eventId,
      variant: context.variant,
      disposition: context.disposition,
    });
  }
}
