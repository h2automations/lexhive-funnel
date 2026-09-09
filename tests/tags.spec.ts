import { expect, test } from '@playwright/test';
import {
  APP_HOST,
  DONE_HEADING,
  FUNNEL_PATH,
  UUID_RE,
  answerAllQualifying,
  gotoFunnel,
  makeContact,
  submitContact,
  waitFor,
  waitForCompleteResponse,
} from './support/funnel';

/**
 * The container, on the wire.
 *
 * Everything else in this directory tests the application. This file tests the
 * part of the system that does not live in the repository at all: GTM
 * container GTM-P34XGVL3, whose fields can be changed by anyone with access,
 * are not in code review, and fail with a green tick in Preview mode.
 *
 * That is the whole reason this file exists. `docs/gtm-setup.md` describes the
 * mapping the design depends on; these tests are the part that notices when
 * the container stops matching the document.
 *
 * Unlike the other suites, nothing here is blocked or stubbed — a stubbed tag
 * test would only prove the stub.
 */

const PIXEL_HOST = 'facebook.com/tr';

test.describe('tag integration', () => {
  test('the funnel ships no hardcoded vendor snippet', async ({ page }) => {
    // The single-container decision, enforced. Every tag moved into GTM so
    // that adding a vendor is a container change rather than a deploy; a
    // snippet creeping back into index.html silently reintroduces a second
    // Pixel initialisation, which is how a container ends up double-counting.
    const html = await (await page.request.get(FUNNEL_PATH)).text();

    expect(html, 'the GTM container snippet is missing from index.html').toContain(
      'googletagmanager.com/gtm.js'
    );

    for (const snippet of ['connect.facebook.net', 'fbq(', 'gtag(', 'clarity.ms']) {
      expect(html, `"${snippet}" is hardcoded in index.html — it belongs in the container`).not.toContain(
        snippet
      );
    }
  });

  test('the first Pixel request carries advanced matching', async ({ page }) => {
    const pixel: URL[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes(PIXEL_HOST)) pixel.push(new URL(url));
    });

    await gotoFunnel(page);
    const first = await waitFor(() => pixel[0]);

    test.skip(
      !first,
      'No Meta Pixel request observed — the container is unpublished, or this network blocks Meta.'
    );

    // GTM loads before React mounts. A Pixel base tag on All Pages therefore
    // initialises before `external_id` exists, and advanced matching starts
    // empty — silently, only on the first pageview of a session, which is the
    // hardest kind of gap to see in a match-quality report. Triggering the base
    // tag on funnel_ready is what fixes it; this is how you find out it was
    // switched back.
    const matchKeys = [...first!.searchParams.keys()].filter((key) => key.startsWith('ud['));
    expect(
      matchKeys,
      'the first Pixel request carried no advanced matching at all — check the base tag triggers on funnel_ready, not All Pages'
    ).not.toHaveLength(0);
    expect(
      matchKeys.join(','),
      'external_id is not mapped on the Pixel base tag; it is the one match key available before the person types anything'
    ).toContain('ud[external_id]');
  });

  test('the browser Lead event carries the event_id the server persisted', async ({ page }) => {
    const pixel: URL[] = [];
    const leaked: string[] = [];
    const contact = makeContact('dedup');

    page.on('request', (request) => {
      const url = request.url();
      if (url.includes(PIXEL_HOST)) pixel.push(new URL(url));

      // The privacy guarantee, checked on the wire rather than on the
      // dataLayer. Meta receives these identifiers hashed, from the SERVER via
      // the Conversions API — never in plaintext from the browser. Only the
      // label is recorded, never the value: this array is printed on failure.
      if (new URL(url).host.endsWith(APP_HOST)) return;
      const haystack = `${url} ${request.postData() ?? ''}`;
      for (const [label, value] of Object.entries(contact)) {
        if (value && haystack.includes(value)) leaked.push(`${label} -> ${new URL(url).host}`);
      }
    });

    await gotoFunnel(page);
    await answerAllQualifying(page);

    const complete = waitForCompleteResponse(page);
    await submitContact(page, contact);
    const res = await complete;

    expect(res.status()).toBe(200);
    const { eventId } = (await res.json()) as { eventId: string };
    expect(eventId).toMatch(UUID_RE);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(DONE_HEADING);

    const lead = await waitFor(() => pixel.find((url) => url.searchParams.get('ev') === 'Lead'));
    test.skip(
      !lead,
      'No browser Lead event observed — check the Qualified Lead tag is published in GTM-P34XGVL3.'
    );

    // The deduplication invariant, one layer further out than the dataLayer
    // assertion in funnel.e2e.spec.ts. The server sends this same id to the
    // Conversions API; if the tag's Event ID field is not mapped to
    // {{DLV - event_id}}, `eid` is absent, nothing errors anywhere, and every
    // conversion is counted twice for as long as nobody looks.
    expect(
      lead!.searchParams.get('eid'),
      'the Lead tag is not sending the server event_id as Event ID — browser and CAPI conversions will not deduplicate'
    ).toBe(eventId);

    expect(leaked, 'contact details reached a third-party host in plaintext').toEqual([]);
  });

  test('no ad or analytics tag fires on the ops surface', async ({ page }) => {
    // GTM itself is deliberately not in this list: the container snippet is in
    // index.html and loads everywhere. What must not happen is a tag firing
    // from it — counting 2am debugging as campaign traffic distorts exactly
    // the numbers that spending decisions are made on.
    //
    // Clarity is also excluded on purpose. It records interaction, feeds no
    // optimisation, and /ops shows no personal data by design, so a recording
    // of it costs nothing.
    const fired: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (/facebook\.com|google-analytics\.com|analytics\.google\.com/.test(url.host)) {
        // Host and path only. The query string of a Pixel request is match
        // data, and this array is printed on failure.
        fired.push(`${url.host}${url.pathname}`);
      }
    });

    await page.goto('/ops');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Delivery operations');
    await page.waitForLoadState('networkidle');

    expect(fired, 'a tag fired on the internal delivery surface').toEqual([]);
  });

  test('Clarity loads exactly once', async ({ page }) => {
    const clarity: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('clarity.ms/tag/')) clarity.push(new URL(url).pathname);
    });

    await gotoFunnel(page);
    await waitFor(() => clarity[0], 8_000);

    test.skip(
      clarity.length === 0,
      'Clarity did not load — the tag is unpublished, or this network blocks clarity.ms.'
    );

    // Two Clarity tags in one container is an easy mistake to make and an
    // invisible one to live with: the script loads twice, every session is
    // recorded twice, and the heatmaps quietly double-count.
    expect(clarity, 'Clarity loaded more than once — there is a duplicate tag in the container').toHaveLength(1);
  });
});
