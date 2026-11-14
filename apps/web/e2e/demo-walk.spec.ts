import {expect, test, type Page} from '@playwright/test';
import {openSection, pageHeading, ProblemCollector, SLOW} from './helpers';

/**
 * Smoke test of the demo path (docs/PRD.md section 19, docs/FLOWS.md Flow A
 * and Flow B) in mock mode. It checks the honesty rules, not only that pages
 * load: the sandbox label next to money, "Approved" is never a paid state,
 * and paid shows only after the verified payment event.
 *
 * The mock keeps its data in page memory, so the walk moves between screens
 * with in-app links (client-side navigation) and never reloads mid-walk.
 */

/**
 * The preview page (/agents/<id>/preview) is built by another worker and is
 * not on main yet. Set this to true when it merges: the preview and publish
 * test runs, and the walk no longer expects Continue to land on a 404.
 */
const PREVIEW_PAGE_MERGED = true;

const SANDBOX_BANNER = 'Sandbox. Payments are test data. No real money moves.';
const PIZZA_PROMPT = 'I run a pizza shop and want an AI that takes pickup orders';
const UNSUPPORTED_ASK = 'also send marketing texts to all my customers';

/** The pizza interview, one owner answer per scripted builder step, with a phrase from each reply. */
const INTERVIEW: readonly {answer: string; reply: RegExp}[] = [
  {answer: PIZZA_PROMPT, reply: /latest pickup time you accept on weekdays/},
  {answer: '9 pm', reply: /How many minutes after an order should it be ready/},
  {answer: '20 minutes', reply: /add a short special request/},
  {answer: 'Yes, up to 140 characters', reply: /Is a text message the right way to send it/},
  {answer: 'Text message', reply: /Every order waits for your approval/},
  {answer: 'Yes', reply: /The draft is ready/},
];

const NOT_PAID = /not paid/i;
const PAID_VERIFIED = /^Paid \(sandbox\)/;

async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await expect(page.getByText('Mock mode', {exact: true})).toBeVisible({timeout: SLOW});
  await page.getByRole('button', {name: 'Continue as demo owner'}).click();
  await expect(page).toHaveURL(/\/overview$/, {timeout: SLOW});
  await expect(pageHeading(page, 'Overview')).toBeVisible({timeout: SLOW});
  await expect(page.getByText(SANDBOX_BANNER)).toBeVisible();
}

/** Types one message into the builder composer and waits for the builder to answer. */
async function sendToBuilder(page: Page, text: string, reply: RegExp): Promise<void> {
  // The Astryx chat composer is a contentEditable textbox.
  const composer = page.getByRole('textbox');
  await expect(composer).not.toHaveAttribute('aria-disabled', 'true', {timeout: SLOW});
  await composer.click();
  await composer.pressSequentially(text);
  const send = page.getByRole('button', {name: /^send/i});
  await expect(send).not.toHaveAttribute('aria-disabled', 'true');
  await send.click();
  await expect(page.getByText(reply).last()).toBeVisible({timeout: SLOW});
}

/** Runs the scripted pizza interview on /build until the draft is complete. */
async function buildPizzaDraft(page: Page): Promise<void> {
  await openSection(page, 'Build an Agent', '/build');
  await expect(pageHeading(page, 'Build an Agent')).toBeVisible({timeout: SLOW});
  await expect(page.getByText('What would you like an agent to do for your business?')).toBeVisible({timeout: SLOW});
  const cont = page.getByRole('button', {name: 'Continue', exact: true});
  await expect(cont).toHaveAttribute('aria-disabled', 'true');

  for (const [i, step] of INTERVIEW.entries()) {
    await sendToBuilder(page, step.answer, step.reply);
    if (i === 0) {
      // An unsupported request is listed as not available and does not move the interview on.
      await sendToBuilder(page, UNSUPPORTED_ASK, /I cannot set up marketing messages and promotions/);
      await expect(page.getByRole('heading', {name: 'Not available', exact: true})).toBeVisible();
      await expect(page.getByText('marketing messages and promotions', {exact: true})).toBeVisible();
    }
  }

  // The capability groups of the draft, by effect.
  for (const group of ['Reads only', 'Proposes, you approve', 'Runs only after your approval']) {
    await expect(page.getByText(group, {exact: true})).toBeVisible();
  }
  await expect(page.getByText('order.checkout.prepare', {exact: true})).toBeVisible();
  // The unsupported request is still shown as not available at the end.
  await expect(page.getByText('marketing messages and promotions', {exact: true})).toBeVisible();
  await expect(page.getByText('6 of 6 details confirmed')).toBeVisible();
  await expect(cont).not.toHaveAttribute('aria-disabled', 'true');
}

/** Presses Continue and returns the new draft agent's ID from the preview URL. */
async function continueToPreview(page: Page): Promise<string> {
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/agents');
  await page.getByRole('button', {name: 'Continue', exact: true}).click();
  expect((await created).status()).toBe(201);
  await expect(page).toHaveURL(/\/agents\/agt_[^/]+\/preview$/, {timeout: SLOW});
  return new URL(page.url()).pathname.split('/')[2];
}

test.describe('demo walk in mock mode', () => {
  test('sign in, build, live call, approve, verified payment, knowledge', async ({page, context}) => {
    const problems = new ProblemCollector({allowPreview404: !PREVIEW_PAGE_MERGED});
    problems.attach(context);

    await test.step('1. sign in and land on Overview with the sandbox banner', async () => {
      await signIn(page);
      problems.expectClean('overview');
    });

    await test.step('2. build the pizza agent by interview', async () => {
      await buildPizzaDraft(page);
      problems.expectClean('build');
    });

    await test.step('3. Continue creates a draft agent and opens its preview', async () => {
      await continueToPreview(page);
      if (PREVIEW_PAGE_MERGED) {
        // The preview page's own checks are in the "preview and publish" test.
        await expect(page.getByRole('heading', {level: 1})).toBeVisible({timeout: SLOW});
      }
      problems.expectClean('continue');
    });

    let approvalHref = '';
    await test.step('4. Live operations: a mock pizza call reaches "Waiting for your approval"', async () => {
      // Until the preview page merges, Continue lands on the Next 404 page,
      // which has no sidebar. Load Live operations directly. This reload
      // resets the in-memory mock, which the rest of the walk does not need.
      // (Going back to /build instead would ask the reset mock for the old
      // builder session and log its expected 404.)
      if (PREVIEW_PAGE_MERGED) await openSection(page, 'Activity', '/activity');
      else await page.goto('/activity');
      await expect(pageHeading(page, 'Live operations')).toBeVisible({timeout: SLOW});
      await expect(page.getByRole('heading', {name: 'Mock controls'})).toBeVisible({timeout: SLOW});
      await page.getByRole('button', {name: 'Start pizza call', exact: true}).click();
      await expect(page.getByText('Mock pizza call started.')).toBeVisible();

      // The detail follows the new call. The shared fixtures already hold pending
      // orders (apv_demo_04, apv_demo_qr), so wait for a Review link that is not one of them.
      const review = page.getByRole('link', {name: 'Review and approve'});
      await expect
        .poll(async () => ((await review.count()) === 1 ? await review.getAttribute('href') : null), {timeout: SLOW})
        .toMatch(/^\/approvals\?id=apv_(?!demo_)/);
      approvalHref = (await review.getAttribute('href'))!;
      await expect(page.getByText('Waiting for your approval', {exact: true}).first()).toBeVisible();
      await expect(page.getByText(/caller ending in 0123/)).toBeVisible();
      problems.expectClean('live call');
    });

    await test.step('5. Approvals: itemized order, sandbox total, approve, "Approved" is not paid', async () => {
      await page.getByRole('link', {name: 'Review and approve'}).click();
      await expect(page).toHaveURL(new RegExp(`${approvalHref.replace(/[?]/g, '\\?')}$`), {timeout: SLOW});
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', {name: 'Order request'})).toBeVisible({timeout: SLOW});

      // Itemized: every line is "<quantity> x <item>" with its amount.
      await expect(dialog.getByText(/^1 x .*Margherita/)).toBeVisible({timeout: SLOW});
      await expect(dialog.getByText(/^1 x .*Pepperoni/)).toBeVisible();
      // The total, with the sandbox label next to it. The amounts are a
      // description list: each term's value is the definition after it.
      const valueOf = (term: string) =>
        dialog.getByRole('term').filter({hasText: new RegExp(`^${term}$`)}).locator('xpath=following-sibling::*[1]');
      await expect(valueOf('Total')).toHaveText(/^\$\d+\.\d{2}\s*Sandbox$/);
      await expect(valueOf('Total').getByText('Sandbox', {exact: true})).toBeVisible();
      // The scripted caller is the caller of the shared pizza timeline (orderFulfilled).
      await expect(valueOf('Customer')).toHaveText('Maya');

      await dialog.getByRole('button', {name: 'Approve', exact: true}).click();
      // The status badge and the outcome card both say Approved, from the state the server returned.
      await expect(dialog.getByText('Approved', {exact: true}).first()).toBeVisible({timeout: SLOW});
      await expect(dialog.getByText(/Approved does not mean done/)).toBeVisible();
      // Approved is not a paid state: nothing in the dialog says paid.
      await expect(dialog.getByText(PAID_VERIFIED)).toHaveCount(0);
      await expect(dialog.getByText(/^Paid\b/)).toHaveCount(0);
      problems.expectClean('approvals');
    });

    await test.step('6. Live operations: link ready with QR, not paid, then verified paid after the payment event', async () => {
      await page.getByRole('link', {name: 'Open Live operations'}).click();
      await expect(pageHeading(page, 'Live operations')).toBeVisible({timeout: SLOW});
      await expect(page.getByText(/caller ending in 0123/)).toBeVisible({timeout: SLOW});

      // The headline of the selected call is the level 3 heading right after the "Now" label.
      // It has no accessible name of its own that tells it apart from the panel headings.
      const now = page.getByText('Now', {exact: true}).locator('xpath=following-sibling::*[1]').getByRole('heading', {level: 3});
      const paymentLine = page.getByText(/^Payment verified with Square/);

      // Open this call's event log so the payment.verified line is on screen when it arrives.
      await page.getByRole('button', {name: /^Event log/}).click();
      // Record, in the page, when the headline first says paid and when the
      // payment.verified line first appears, so the order can be checked after.
      await page.evaluate(() => {
        const w = window as unknown as {__paidAt?: number; __verifiedAt?: number};
        const check = () => {
          const label = [...document.querySelectorAll('span, p, div')].find((el) => el.childElementCount === 0 && el.textContent === 'Now');
          const headline = label?.nextElementSibling?.querySelector('h3')?.textContent ?? '';
          if (w.__paidAt === undefined && headline.startsWith('Paid (sandbox)')) w.__paidAt = performance.now();
          if (w.__verifiedAt === undefined && /Payment verified with Square/.test(document.body.innerText)) w.__verifiedAt = performance.now();
        };
        check();
        new MutationObserver(check).observe(document.body, {subtree: true, childList: true, characterData: true});
      });

      // First the intermediate state: link ready, not paid. Paid must not show yet.
      await expect(now).toHaveText(NOT_PAID, {timeout: SLOW});
      await expect(page.getByRole('img', {name: 'QR code for the Square sandbox checkout link'})).toBeVisible();
      await expect(page.getByText('Square sandbox', {exact: true})).toBeVisible();
      await expect(page.getByText('Sandbox test payment only')).toBeVisible();
      // (The call list can hold an older fixture call that is paid, so the
      // paid checks look at this call's detail only: its headline and its
      // "verified with Square" line.)
      await expect(now).not.toHaveText(PAID_VERIFIED);
      await expect(page.getByText(/verified with Square\. Payment/)).toHaveCount(0);
      // The scripted payment.verified event has not arrived yet.
      await expect(paymentLine).toHaveCount(0);

      // Then the scripted payment event arrives and only then the paid state shows.
      await expect(paymentLine).toBeVisible({timeout: SLOW});
      await expect(now).toHaveText(PAID_VERIFIED, {timeout: SLOW});
      await expect(page.getByText(/^Paid \(sandbox\), verified with Square\. Payment /)).toBeVisible();
      const order = await page.evaluate(() => {
        const w = window as unknown as {__paidAt?: number; __verifiedAt?: number};
        return {paidAt: w.__paidAt, verifiedAt: w.__verifiedAt};
      });
      expect(order.verifiedAt, 'the payment.verified line was seen').toBeDefined();
      expect(order.paidAt, 'the paid headline was seen').toBeDefined();
      expect(order.paidAt!, 'paid showed before the payment.verified event').toBeGreaterThanOrEqual(order.verifiedAt!);
      // The amount keeps its sandbox label, and the QR code is gone once paid.
      await expect(now.locator('xpath=../..').getByText('Sandbox', {exact: true})).toBeVisible();
      await expect(page.getByText('Square verified the payment, so the QR code is hidden.')).toBeVisible();
      problems.expectClean('payment');
    });

    await test.step('7. Business Knowledge: the conflict banner for the pizza business', async () => {
      await openSection(page, 'Business Knowledge', '/knowledge');
      await expect(pageHeading(page, 'Business Knowledge')).toBeVisible({timeout: SLOW});
      await expect(page.getByText(/^\d+ conflicts? (is|are) open$/)).toBeVisible({timeout: SLOW});
      await expect(page.getByText(/Publish is blocked while a required conflict is open/)).toBeVisible();
      problems.expectClean('knowledge');
    });
  });

  test('preview and publish', async ({page, context}) => {
    test.fixme(!PREVIEW_PAGE_MERGED, 'The preview page (/agents/<id>/preview) is not on main yet. Set PREVIEW_PAGE_MERGED to true when it merges.');
    const problems = new ProblemCollector();
    problems.attach(context);

    await signIn(page);
    // The pizza fixture has a required conflict (cfl_pizza_01) that blocks publish. Keep Square's price first.
    await openSection(page, 'Business Knowledge', '/knowledge');
    await page.getByRole('button', {name: 'Keep the Square price'}).first().click();
    await expect(page.getByText(/Publish is blocked while a required conflict is open/)).toHaveCount(0, {timeout: SLOW});

    await buildPizzaDraft(page);
    await continueToPreview(page);

    // The preview shows the agent, and a test conversation that runs on mock tools only.
    await expect(page.getByText('Pizza Order Assistant').first()).toBeVisible({timeout: SLOW});
    await expect(page.getByText('Test with mock tools').first()).toBeVisible();
    const composer = page.getByRole('textbox').last();
    await composer.click();
    await composer.pressSequentially('Two large pepperoni for pickup at 6');
    await page.getByRole('button', {name: /^send/i}).last().click();
    // The tool trace is labelled as a test with mock tools.
    await expect(page.getByText(/tool trace/i).first()).toBeVisible({timeout: SLOW});
    await expect(page.getByText(/mock tools?/i).first()).toBeVisible();

    // Publish asks for confirmation first, then shows the live number and the version.
    await page.getByRole('button', {name: /^Publish/}).first().click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', {name: /^(Publish|Confirm)/}).click();
    await expect(page.getByText(/\+1\s?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/).first()).toBeVisible({timeout: SLOW});
    await expect(page.getByText(/\bv(ersion\s)?\d+\b/i).first()).toBeVisible();
    problems.expectClean('preview and publish');
  });
});
