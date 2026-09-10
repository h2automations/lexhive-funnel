import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  CONTACT_HEADING,
  Q,
  UUID_RE,
  answerQuestion,
  fillContact,
  gotoFunnel,
  makeContact,
  selectState,
  waitForCompleteResponse,
  type Contact,
} from './support/funnel';
import { countCohort, dbQueryJson, dbQueryText, deliveryStatus, hasDb, waitForSettled } from './support/db';

/**
 * Meta CAPI delivery verification tests.
 *
 * Verifies that the event the drain actually sends to Meta carries the right
 * event_id for browser/server deduplication and normalized (hashed) Advanced
 * Matching identifiers — and, just as important, that the plaintext contact
 * details never leave the outbox payload.
 *
 * The payload is read from Postgres after settlement, so these tests exercise
 * the real delivery path end to end: submission → outbox → drain → Meta's
 * success recorded back in the outbox row.
 */

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const CONTACT_COHORT: string[] = [];

async function submitQualifiedLead(page: Page, contact: Contact): Promise<{ leadId: string; eventId: string }> {
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
  await expect(page.getByText(/thank you/i)).toBeVisible({ timeout: 10_000 });
  return { leadId: body.leadId, eventId: body.eventId };
}

test.skip(!hasDb(), 'DATABASE_URL / PGPASSWORD not set — see .env.e2e.example');

test.describe('Meta CAPI Delivery', () => {
  test('1 — event_id in the outbox matches the submission eventId', async ({ page }) => {
    const contact = makeContact('capi1');
    const { leadId, eventId } = await submitQualifiedLead(page, contact);
    CONTACT_COHORT.push(leadId);

    const settled = await waitForSettled(leadId, 20_000);
    expect(settled, 'the drain must settle every row for this lead').toBe(true);

    expect(deliveryStatus(leadId, 'meta_capi')).toBe('succeeded');
    expect(deliveryStatus(leadId, 'n8n_airtable')).toBe('succeeded');

    const outboxEventId = dbQueryText(
      `select payload->>'event_id' from delivery_outbox where lead_id = '${leadId}' and destination = 'meta_capi'`
    );
    expect(outboxEventId).toBe(eventId);
  });

  test('2 — the outbound payload carries hashed Advanced Matching, never plaintext', async ({ page }) => {
    const contact = makeContact('capi2');
    const { leadId, eventId } = await submitQualifiedLead(page, contact);
    CONTACT_COHORT.push(leadId);

    const settled = await waitForSettled(leadId, 20_000);
    expect(settled, 'the drain must settle every row for this lead').toBe(true);

    const payloadText = dbQueryText(
      `select payload::text from delivery_outbox where lead_id = '${leadId}' and destination = 'meta_capi'`
    );
    const payload = dbQueryJson(
      `select payload from delivery_outbox where lead_id = '${leadId}' and destination = 'meta_capi'`
    ) as Record<string, unknown> | null;

    expect(payload, 'the outbound payload must exist').toBeTruthy();
    expect(payload!.event_id).toBe(eventId);
    expect(typeof payload!.request_id).toBe('string');

    // Advanced Matching is REQUIRED to be hashed before Meta ever sees it; the
    // normalization rules are asserted in detail by the unit suite. Here we
    // read back the EXACT event Meta accepted (the drain stores it under
    // `delivered`) and assert the same hashes against the value hand-normalized
    // the way the unit suite does: 10-digit phone gets the US country code,
    // email is trimmed and lowercased.
    const delivered = payload!.delivered as Record<string, unknown> | undefined;
    expect(delivered, 'the delivered CAPI event must be stored for audit').toBeTruthy();
    const userData = (delivered as Record<string, any>).user_data as Record<string, unknown>;
    expect(userData.em).toBe(sha256(contact.email.toLowerCase()));
    expect(userData.ph).toBe(sha256('15550100100'));

    // The other half of the guarantee: the plaintext never rides in the payload
    // text at all, so no log or downstream misread can leak it.
    expect(payloadText).not.toContain('5550100100');
    expect(payloadText).not.toContain(contact.email.toLowerCase().split('@')[0]!);
  });

  test('3 — the cohort leaves no dead-lettered rows', async () => {
    expect(countCohort(CONTACT_COHORT, ['dead'])).toBe(0);
  });

  test('4 — the cohort settles with no rows stuck pending or failed', async () => {
    expect(countCohort(CONTACT_COHORT, ['pending', 'failed', 'delivering'])).toBe(0);
  });
});