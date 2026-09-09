import { expect, test } from '@playwright/test';
import { execSync } from 'child_process';
import {
  Q,
  UUID_RE,
  answerQuestion,
  fillContact,
  gotoFunnel,
  makeContact,
  waitForCompleteResponse,
  type Contact,
} from './support/funnel';

/**
 * Meta CAPI delivery verification tests.
 *
 * Verifies that server events reach Meta with the right event_id for
 * deduplication, and that advanced matching fields are present.
 */

const APP_BASE = (process.env.BASE_URL || 'https://lexhive.vercel.app').replace(/\/+$/, '');
const DB_CONN = process.env.DATABASE_URL || '';
const DB_PASS = process.env.PGPASSWORD || '';
const HAS_DB = Boolean(DB_CONN && DB_PASS);

function dbQuery(query: string): string {
  if (!HAS_DB) return '';
  try {
    return execSync(
      `PGPASSWORD='${DB_PASS}' psql -tA "${DB_CONN}" -c "${query}"`,
      { encoding: 'utf-8', timeout: 30000 }
    ).trim();
  } catch (e) {
    console.error('DB query failed:', e);
    return '';
  }
}

async function waitForDelivery(leadId: string, maxWaitMs: number = 15000): Promise<boolean> {
  if (!HAS_DB) return false;
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    const pending = dbQuery(`SELECT COUNT(*) FROM delivery_outbox WHERE lead_id='${leadId}' AND status='pending'`);
    if (pending === '0') return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const CONTACT_HEADING = 'A few details to finish';

async function submitQualifiedLead(page: Page, contact: Contact): Promise<{ leadId: string; eventId: string }> {
  await gotoFunnel(page);
  await answerQuestion(page, 'Yes', Q.gender);
  await answerQuestion(page, 'Prefer not to say', Q.state);
  await answerQuestion(page, 'Texas', Q.work);
  await answerQuestion(page, 'Yes', Q.duration);
  await answerQuestion(page, 'Yes', Q.doctor);
  await answerQuestion(page, 'Yes', Q.months);
  await answerQuestion(page, 'Yes', CONTACT_HEADING);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(CONTACT_HEADING);
  await fillContact(page, contact);
  await page.getByRole('checkbox').check();

  const completeResponse = waitForCompleteResponse(page);
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const res = await completeResponse;
  const body = await res.json();
  await expect(page.getByText(/thank you/i)).toBeVisible({ timeout: 10000 });
  return { leadId: body.leadId, eventId: body.eventId };
}

test.skip(!HAS_DB, 'DATABASE_URL / PGPASSWORD not set — see .env.e2e.example');

test.describe('Meta CAPI Delivery', () => {
  test('1 — event_id in outbox matches submission eventId', async ({ page }) => {
    const contact = makeContact('capi1');
    const { leadId, eventId } = await submitQualifiedLead(page, contact);

    const ok = await waitForDelivery(leadId, 15000);
    expect(ok).toBe(true);

    const metaStatus = dbQuery(
      `SELECT status FROM delivery_outbox WHERE lead_id='${leadId}' AND destination='meta_capi'`
    );
    expect(metaStatus).toBe('succeeded');

    const outboxEventId = dbQuery(
      `SELECT payload->>'event_id' FROM delivery_outbox WHERE lead_id='${leadId}' AND destination='meta_capi'`
    );
    expect(outboxEventId).toBe(eventId);
  });

  test('2 — advanced matching fields present in payload', async ({ page }) => {
    const contact = makeContact('capi2');
    const { leadId } = await submitQualifiedLead(page, contact);

    const ok = await waitForDelivery(leadId, 15000);
    expect(ok).toBe(true);

    const payload = dbQuery(
      `SELECT payload::text FROM delivery_outbox WHERE lead_id='${leadId}' AND destination='meta_capi'`
    );
    expect(payload).toContain('event_id');
    expect(payload).toContain('event_name');
    expect(payload).toContain('request_id');
  });

  test('3 — no dead-lettered rows in outbox', async () => {
    const count = dbQuery(`SELECT COUNT(*) FROM delivery_outbox WHERE status='dead_lettered'`);
    expect(count).toBe('0');
  });

  test('4 — zero pending rows in outbox', async () => {
    const count = dbQuery(`SELECT COUNT(*) FROM delivery_outbox WHERE status='pending'`);
    expect(count).toBe('0');
  });
});
