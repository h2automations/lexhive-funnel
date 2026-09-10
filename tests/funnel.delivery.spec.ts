import { expect, test, type Page } from '@playwright/test';
import {
  CONTACT_HEADING,
  NOMATCH_HEADING,
  Q,
  RESTRICTED_HEADING,
  UUID_RE,
  answerQuestion,
  fillContact,
  gotoFunnel,
  makeContact,
  selectState,
  waitForCompleteResponse,
  type Contact,
} from './support/funnel';
import { countCohort, dbQueryText, deliveryStatus, hasDb, waitForSettled } from './support/db';

/**
 * Delivery pipeline tests.
 *
 * Verifies the full submission → outbox → drain path for each disposition:
 * qualified enqueues both destinations, restricted and disqualified-no-opt-in
 * enqueue nothing, and a disqualified nurture opt-in enqueues the nurture row
 * and the NurtureOptIn event — never the sales conversion. Every row the tests
 * created reaches a terminal state. The final test is scoped to this run's
 * cohort — the store is shared with the live funnel, so a global "zero
 * pending" assertion would answer for traffic the tests did not make.
 */

const APP_BASE = (process.env.BASE_URL || 'https://lexhive.vercel.app').replace(/\/+$/, '');
const OPS_KEY = process.env.OPS_KEY || '';
const COHORT: string[] = [];

const DONE_TEXT = /thank you/i;

async function driveQualifiedFunnel(page: Page, contact: Contact): Promise<{ leadId: string; eventId: string }> {
  await gotoFunnel(page);
  await answerQuestion(page, 'Yes', Q.state);
  await selectState(page, 'Texas', Q.work);
  await answerQuestion(page, 'Yes', Q.duration);
  await answerQuestion(page, 'Yes', Q.workHistory);
  await answerQuestion(page, 'Yes', Q.doctor);
  await answerQuestion(page, 'Yes', CONTACT_HEADING);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(CONTACT_HEADING);
  await fillContact(page, contact);
  await page.getByRole('checkbox').check();

  const completeResponse = waitForCompleteResponse(page);
  await page.getByRole('button', { name: 'Request a callback', exact: true }).click();
  const res = await completeResponse;
  const body = await res.json();
  await expect(page.getByText(DONE_TEXT)).toBeVisible({ timeout: 10_000 });
  return { leadId: body.leadId, eventId: body.eventId };
}

async function driveRestrictedFunnel(page: Page): Promise<{ leadId: string; eventId: string }> {
  await gotoFunnel(page);
  await answerQuestion(page, 'Yes', Q.state);
  await selectState(page, 'New York', RESTRICTED_HEADING);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(RESTRICTED_HEADING);
  await page.getByRole('checkbox').check();
  const completeResponse = waitForCompleteResponse(page);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const res = await completeResponse;
  const body = await res.json();
  await expect(page.getByText(DONE_TEXT)).toBeVisible({ timeout: 10_000 });
  return { leadId: body.leadId, eventId: body.eventId };
}

/**
 * Knock out on the "cannot work" question, land on the non-match screen, then
 * leave via "No thanks" — the no-contact exit. `followUpOptIn` is not sent, so
 * nothing further is stored and no delivery is enqueued.
 */
async function driveDisqualifiedNoOption(page: Page): Promise<{ leadId: string; eventId: string }> {
  await gotoFunnel(page);
  await answerQuestion(page, 'Yes', Q.state);
  await selectState(page, 'Texas', Q.work);
  const completeResponse = waitForCompleteResponse(page);
  await answerQuestion(page, 'No', NOMATCH_HEADING);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NOMATCH_HEADING);
  await page.getByRole('button', { name: 'No thanks', exact: true }).click();
  const res = await completeResponse;
  const body = await res.json();
  expect(body.disposition).toBe('disqualified');
  await expect(page.getByText(DONE_TEXT)).toBeVisible({ timeout: 10_000 });
  return { leadId: body.leadId, eventId: body.eventId };
}

/**
 * Knock out on "cannot work", then opt into nurture: minimal contact plus the
 * separate nurture consent. This is the ONLY disqualified flow that stores
 * contact, and it must reach n8n as a nurture row plus Meta as NurtureOptIn —
 * never as the sales Lead.
 */
async function driveDisqualifiedNurture(page: Page): Promise<{ leadId: string; eventId: string }> {
  await gotoFunnel(page);
  await answerQuestion(page, 'Yes', Q.state);
  await selectState(page, 'Texas', Q.work);
  const completeResponse = waitForCompleteResponse(page);
  await answerQuestion(page, 'No', NOMATCH_HEADING);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NOMATCH_HEADING);
  await page
    .getByRole('button', { name: 'Keep me updated about programs that may fit', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Keep me updated');

  const contact = makeContact('nurture');
  await page.getByLabel('First name', { exact: true }).fill(contact.firstName);
  await page.getByLabel('Email', { exact: true }).fill(contact.email);
  await page.getByLabel('Phone', { exact: true }).fill(contact.phone);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const res = await completeResponse;
  const body = await res.json();
  expect(body.disposition).toBe('disqualified');
  await expect(page.getByText(DONE_TEXT)).toBeVisible({ timeout: 10_000 });
  return { leadId: body.leadId, eventId: body.eventId };
}

test.skip(!hasDb(), 'DATABASE_URL / PGPASSWORD not set — see .env.e2e.example');

test.describe('Delivery Pipeline', () => {
  test('1 — qualified submission delivers to both destinations', async ({ page }) => {
    const contact = makeContact('deliv');
    const { leadId, eventId } = await driveQualifiedFunnel(page, contact);
    COHORT.push(leadId);

    expect(leadId).toMatch(UUID_RE);
    expect(eventId).toMatch(UUID_RE);

    const settled = await waitForSettled(leadId, 20_000);
    expect(settled, 'self-trigger should settle every outbox row within 20s').toBe(true);

    expect(deliveryStatus(leadId, 'meta_capi')).toBe('succeeded');
    expect(deliveryStatus(leadId, 'n8n_airtable')).toBe('succeeded');
  });

  test('2 — restricted submission enqueues nothing', async ({ page }) => {
    const { leadId } = await driveRestrictedFunnel(page);
    COHORT.push(leadId);
    expect(leadId).toMatch(UUID_RE);

    // A restricted lead is not a lead at all: no sales, no nurture, no Meta.
    // The absence of a row is the contract — waitForSettled is trivially true
    // because there was never anything to deliver.
    const settled = await waitForSettled(leadId, 20_000);
    expect(settled).toBe(true);
    expect(deliveryStatus(leadId, 'n8n_airtable')).toBeNull();
    expect(deliveryStatus(leadId, 'meta_capi')).toBeNull();
  });

  test('3 — disqualified no-opt-in submission enqueues nothing', async ({ page }) => {
    const { leadId } = await driveDisqualifiedNoOption(page);
    COHORT.push(leadId);
    expect(leadId).toMatch(UUID_RE);

    const settled = await waitForSettled(leadId, 20_000);
    expect(settled).toBe(true);
    expect(deliveryStatus(leadId, 'n8n_airtable')).toBeNull();
    expect(deliveryStatus(leadId, 'meta_capi')).toBeNull();
  });

  test('3b — disqualified nurture opt-in delivers to n8n (nurture) and Meta (NurtureOptIn)', async ({ page }) => {
    const { leadId } = await driveDisqualifiedNurture(page);
    COHORT.push(leadId);
    expect(leadId).toMatch(UUID_RE);

    const settled = await waitForSettled(leadId, 20_000);
    expect(settled, 'nurture deliveries should settle within 20s').toBe(true);
    expect(deliveryStatus(leadId, 'n8n_airtable')).toBe('succeeded');
    expect(deliveryStatus(leadId, 'meta_capi')).toBe('succeeded');

    // The Meta event must be the nurture opt-in, not the sales conversion —
    // an assertion that also guards against the event_id namespace drifting.
    const testLeadId = leadId;
    expect(
      dbQueryText(
        `select payload->>'event_name' from delivery_outbox
           where lead_id = '${testLeadId}' and destination = 'meta_capi'`
      )
    ).toBe('NurtureOptIn');
    expect(
      dbQueryText(
        `select payload->>'event_id' from delivery_outbox
           where lead_id = '${testLeadId}' and destination = 'meta_capi'`
      )
    ).toBe(`nurture_${testLeadId}`);
  });

  test('4 — burst submissions all deliver', async ({ page }) => {
    const leads: { leadId: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const contact = makeContact(`burst${i}`);
      const { leadId } = await driveQualifiedFunnel(page, contact);
      leads.push({ leadId });
      COHORT.push(leadId);
    }

    for (const { leadId } of leads) {
      const settled = await waitForSettled(leadId, 25_000);
      expect(settled, `${leadId} should settle`).toBe(true);
      expect(deliveryStatus(leadId, 'meta_capi')).toBe('succeeded');
      expect(deliveryStatus(leadId, 'n8n_airtable')).toBe('succeeded');
    }
  });

  test('5 — ops shows healthy after delivery', async () => {
    test.skip(!OPS_KEY, 'OPS_KEY is not set — see .env.e2e.example.');
    const resp = await fetch(`${APP_BASE}/api/ops`, { headers: { 'x-ops-key': OPS_KEY } });
    expect(resp.ok).toBe(true);
    const data = await resp.json();
    expect(data.problems).toEqual([]);
    const meta = data.health.find((h: any) => h.destination === 'meta_capi');
    const n8n = data.health.find((h: any) => h.destination === 'n8n_airtable');
    expect(meta?.status).toBe('healthy');
    expect(n8n?.status).toBe('healthy');
  });

  test('6 — the cohort leaves nothing pending and nothing dead', async () => {
    expect(countCohort(COHORT, ['pending', 'failed', 'delivering'])).toBe(0);
    expect(countCohort(COHORT, ['dead'])).toBe(0);
  });
});