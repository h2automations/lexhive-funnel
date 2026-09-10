import { expect, test, type Locator } from '@playwright/test';
import { Q, answerAllQualifying, answerQuestion, blockThirdPartyTags, gotoFunnel, selectState } from './support/funnel';

/**
 * The design decisions that carry the conversion rate.
 *
 * The audience is people over 40 who cannot work, arriving from a Meta ad on a
 * phone, often with a vision, motor or cognitive impairment. For them
 * legibility and completion are the same variable, which makes these
 * assertions commercial rather than cosmetic — a 4rem target and a rem-based
 * scale are worth failing a build over.
 *
 * Focus management and keyboard operation are covered by test 6 in
 * `funnel.e2e.spec.ts`; this file covers what that one cannot see — physical
 * size, how the page responds to an enlarged device font, and whether the
 * contact step can be autofilled instead of typed.
 *
 * Third-party tags are blocked throughout: layout must not depend on whether
 * a marketing script loaded, and blocking keeps these deterministic.
 */

const fontSize = (locator: Locator) =>
  locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

const height = (locator: Locator) => locator.evaluate((el) => el.getBoundingClientRect().height);

test.describe('legibility and input ergonomics', () => {
  test.beforeEach(async ({ page }) => {
    await blockThirdPartyTags(page);
  });

  test('every answer target is at least 4rem tall', async ({ page }) => {
    await gotoFunnel(page);

    const check = async (heading: string) => {
      const options = page.locator('.options button');
      const count = await options.count();
      expect(count, `no options rendered on "${heading}"`).toBeGreaterThan(0);

      for (let i = 0; i < count; i++) {
        const box = await options.nth(i).boundingBox();
        // 4rem at the 16px default. A tap target that a person with a tremor
        // misses is a person who does not finish the funnel.
        expect(box!.height, `option ${i + 1} on "${heading}" is ${box!.height}px`).toBeGreaterThanOrEqual(63);
      }
    };

    await check(Q.age);

    // The state screen is a picker behind a confirm — the ones most likely to
    // have been shrunk to fit a small phone.
    await answerQuestion(page, 'Yes', Q.state);
    const picker = page.locator('#state-picker');
    expect((await picker.boundingBox())?.height).toBeGreaterThanOrEqual(63);
    expect((await page.getByRole('button', { name: 'Check availability' }).boundingBox())?.height).toBeGreaterThanOrEqual(63);

    await selectState(page, 'Texas', Q.work);
    await check(Q.work);
  });

  test('an enlarged device font actually enlarges the page', async ({ page }) => {
    await gotoFunnel(page);

    const heading = page.getByRole('heading', { level: 1 });
    const option = page.locator('.options button').first();
    const before = { heading: await fontSize(heading), option: await height(option) };

    // Someone who has set their phone's text size to Large has already told the
    // device what they need. A px-based scale silently ignores that; this is
    // the assertion that notices px being reintroduced, which is otherwise
    // invisible to everyone testing at default settings.
    await page.addStyleTag({ content: 'html { font-size: 150% !important; }' });

    expect(await fontSize(heading), 'the heading did not grow with the root font size').toBeGreaterThan(
      before.heading * 1.4
    );
    expect(await height(option), 'the answer targets did not grow with the root font size').toBeGreaterThan(
      before.option * 1.4
    );
  });

  test('the contact step is autofillable and masked from session recording', async ({ page }) => {
    await gotoFunnel(page);
    await answerAllQualifying(page);

    for (const [id, token, inputMode] of [
      ['first', 'given-name', null],
      ['last', 'family-name', null],
      ['email', 'email', 'email'],
      ['phone', 'tel', 'tel'],
      ['zip', 'postal-code', 'numeric'],
    ] as const) {
      const field = page.locator(`#${id}`);
      // Autofill is not a nicety for someone with a motor impairment on a
      // phone; it is the difference between finishing and abandoning.
      await expect(field, `#${id} is missing its autocomplete token`).toHaveAttribute('autocomplete', token);
      await expect(page.locator(`label[for="${id}"]`), `#${id} has no visible label`).toBeVisible();
      if (inputMode) {
        // The right on-screen keyboard, first time.
        await expect(field).toHaveAttribute('inputmode', inputMode);
      }
    }

    // Clarity masks input values by default, but a default is not a control.
    // This form holds a name, a phone number and a TCPA consent record, and the
    // mask belongs in markup where it survives a dashboard setting being
    // changed by someone who does not know that.
    await expect(page.locator('form[data-clarity-mask="true"]')).toBeVisible();
  });

  test('nothing overflows sideways on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoFunnel(page);

    const overflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    // Sideways scrolling on a phone reads as a broken page, and this traffic is
    // almost entirely phones.
    expect(await overflow(), 'the first question overflows the viewport').toBeLessThanOrEqual(1);

    await answerQuestion(page, 'Yes', Q.state);
    expect(await overflow(), 'the state picker overflows the viewport').toBeLessThanOrEqual(1);

    await selectState(page, 'Texas', Q.work);
    expect(await overflow(), 'the work question overflows the viewport').toBeLessThanOrEqual(1);
  });
});
