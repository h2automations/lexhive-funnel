import { expect, test } from '@playwright/test';
import {
  CONTACT_HEADING,
  DONE_HEADING,
  Q,
  QUESTION_SCREENS,
  RESTRICTED_HEADING,
  UUID_RE,
  answerAllQualifying,
  answerQuestion,
  blockThirdPartyTags,
  gotoFunnel,
  isLeadPost,
  makeContact,
  submitContact,
  waitForCompleteResponse,
} from './support/funnel';

/**
 * What the funnel does when something underneath it breaks.
 *
 * `funnel.e2e.spec.ts` walks the happy paths. This file walks the ones that
 * decide whether a bad afternoon costs leads: a save that 500s, a compliance
 * lookup that never answers, an ad blocker, a person who taps Back. Every
 * assertion here corresponds to a failure mode that is invisible from the
 * outside — the funnel keeps rendering, and the damage only shows up later as
 * a number that is quietly wrong.
 *
 * Privacy: request bodies are never captured whole. Only `status` and
 * `leadId` are lifted out, because a captured body would be answer data and
 * would end up printed in a CI log on the first failure.
 */
test.describe('resilience', () => {
  test('every answer updates one lead row rather than inserting another', async ({ page }) => {
    // The regression this guards: each answer used to POST an insert, so one
    // abandoned session left seven rows and every count on /ops — and every
    // conversion rate derived from it — was a multiple of the truth.
    const saves: {
      status: string;
      sentLeadId: string | null;
      body: Promise<{ leadId?: string } | null>;
    }[] = [];

    page.on('response', (res) => {
      const request = res.request();
      if (!isLeadPost(res.url(), request.method())) return;
      let sent: { status?: string; leadId?: string | null } | null = null;
      try {
        sent = request.postDataJSON();
      } catch {
        sent = null;
      }
      saves.push({
        status: sent?.status ?? 'unknown',
        sentLeadId: sent?.leadId ?? null,
        body: res.json().catch(() => null),
      });
    });

    await gotoFunnel(page);
    await answerAllQualifying(page);

    // One save per question, including the last — that is what makes the
    // drop-off number for the final question truthful.
    await expect
      .poll(() => saves.filter((s) => s.status === 'partial').length, {
        message: 'partial saves observed',
        timeout: 15_000,
      })
      .toBe(QUESTION_SCREENS.length);

    const partials = saves.filter((s) => s.status === 'partial');
    const returned = await Promise.all(partials.map((s) => s.body));

    const rowId = returned[0]?.leadId;
    expect(rowId, 'the first partial save must hand back a row id').toMatch(UUID_RE);

    // The browser must send back the id it was given...
    expect(
      partials.slice(1).map((s) => s.sentLeadId),
      'a later save did not carry the row id from the first save'
    ).toEqual(partials.slice(1).map(() => rowId));

    // ...and the server must keep answering with the same row.
    expect(
      new Set(returned.map((r) => r?.leadId)).size,
      'the server created more than one row for a single session'
    ).toBe(1);
  });

  test('a failed completion surfaces an error rather than a thank-you', async ({ page }) => {
    // Fail only the completion. The partial saves go through, so this is the
    // narrow case where the person has typed everything and the last write
    // fails — the one moment where a silent failure loses a real lead.
    await page.route('**/api/lead', async (route) => {
      let sent: { status?: string } | null = null;
      try {
        sent = route.request().postDataJSON();
      } catch {
        sent = null;
      }
      if (sent?.status === 'complete') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'write_failed' }),
        });
        return;
      }
      await route.continue();
    });

    await gotoFunnel(page);
    await answerAllQualifying(page);
    await submitContact(page, makeContact('failed-submit'));

    const alert = page.locator('p.error[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText(/try again/i);

    // Still on the form, with the typing intact and the button usable again.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(CONTACT_HEADING);
    await expect(page.getByRole('heading', { name: DONE_HEADING, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Email', { exact: true })).not.toBeEmpty();
  });

  test('an unavailable compliance lookup fails closed', async ({ page }) => {
    // Every save fails, so the server never returns a disposition.
    await page.route('**/api/lead', (route) => route.fulfill({ status: 500, body: '{}' }));

    await gotoFunnel(page);

    // The funnel still runs to the end: a save outage must never be the reason
    // a person cannot finish...
    await answerAllQualifying(page, RESTRICTED_HEADING);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(RESTRICTED_HEADING);

    // ...but with no verdict on the state, it must not ask for contact details.
    // Failing open here would mean collecting a name and phone number in a
    // state where passing them on is not allowed.
    for (const label of ['First name', 'Last name', 'Email', 'Phone', 'ZIP code']) {
      await expect(
        page.getByLabel(label, { exact: true }),
        `asked for ${label} without a compliance verdict`
      ).toHaveCount(0);
    }
  });

  test('a lead is captured with every marketing tag blocked', async ({ page }) => {
    // Roughly a third of this audience runs a blocker, and GTM is a third-party
    // script on the critical path of the page. If the funnel needs it to be
    // reachable in order to capture a lead, a marketing tag has become
    // load-bearing for revenue.
    await blockThirdPartyTags(page);

    await gotoFunnel(page);
    await answerAllQualifying(page);

    const complete = waitForCompleteResponse(page);
    await submitContact(page, makeContact('blocked-tags'));
    const res = await complete;

    expect(res.status()).toBe(200);
    const result = await res.json();
    expect(result.leadId).toMatch(UUID_RE);
    expect(result.disposition).toBe('qualified');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(DONE_HEADING);
  });

  test('Back returns to the last question with the answers intact', async ({ page }) => {
    await gotoFunnel(page);
    await answerAllQualifying(page);

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(Q.months);

    await answerQuestion(page, 'Yes', CONTACT_HEADING);

    // The qualified contact step only renders while the state verdict from the
    // earlier save is still held, so seeing the email field proves the earlier
    // answers survived the round trip rather than being reset.
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  });
});
